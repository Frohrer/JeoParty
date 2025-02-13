import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { Room } from './room';
//@ts-ignore
import Papa from 'papaparse';
import { redisCount } from './utils/redis';
const jData = require('../jeopardy.json');
import OpenAI from 'openai';
let redis = undefined as unknown as Redis;

const CORRECT_PHRASES = [
  "That's correct!",
  "Well done!",
  "You got it!",
  "Exactly right!",
  "That's it!",
  "Perfect!",
  "Right you are!",
  "That's absolutely right!",
  "Correct!",
  "Yes, that's it!",
];

const INCORRECT_PHRASES = [
  "I'm sorry, that's incorrect.",
  "Oh no, that's not it.",
  "Not quite right.",
  "Sorry, wrong answer.",
  "That's not correct.",
  "No, that's not it.",
  "That's not the one we're looking for.",
  "Not what we had in mind.",
  "Unfortunately, that's wrong.",
  "No, I'm afraid that's incorrect."
];

async function getRandomPhrase(isCorrect: boolean): Promise<ArrayBuffer> {
  const phrases = isCorrect ? CORRECT_PHRASES : INCORRECT_PHRASES;
  const phrase = phrases[Math.floor(Math.random() * phrases.length)];
  return await speakText(phrase);
}

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface RawQuestion {
  val: number;
  cat: string;
  x?: number;
  y?: number;
  q?: string;
  a?: string;
  dd?: boolean;
}

interface Question {
  value: number;
  category: string;
  question?: string;
  answer?: string;
  daily_double?: boolean;
}

function constructBoard(questions: RawQuestion[]) {
  // Map of x_y coordinates to questions
  let output: { [key: string]: RawQuestion } = {};
  questions.forEach((q) => {
    output[`${q.x}_${q.y}`] = q;
  });
  return output;
}

function constructPublicBoard(questions: RawQuestion[]) {
  // Map of x_y coordinates to questions
  let output: { [key: string]: Question } = {};
  questions.forEach((q) => {
    output[`${q.x}_${q.y}`] = {
      value: q.val,
      category: q.cat,
    };
  });
  return output;
}

function syllableCount(word: string) {
  word = word.toLowerCase(); //word.downcase!
  if (word.length <= 3) {
    return 1;
  }
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, ''); //word.sub!(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
  word = word.replace(/^y/, '');
  let vowels = word.match(/[aeiouy]{1,2}/g);
  // Use 3 as the default if no letters, it's probably a year
  return vowels ? vowels.length : 3;
}

function getPerQuestionState() {
  return {
    currentQ: '',
    currentAnswer: undefined as string | undefined,
    currentValue: 0,
    currentJudgeAnswer: undefined as string | undefined,
    currentJudgeAnswerIndex: undefined as number | undefined,
    currentDailyDouble: false,
    waitingForWager: undefined as BooleanDict | undefined,
    playClueDuration: 0,
    playClueEndTS: 0,
    questionDuration: 0,
    questionEndTS: 0,
    wagerEndTS: 0,
    wagerDuration: 0,
    buzzUnlockTS: 0,
    answers: {} as StringDict,
    submitted: {} as BooleanDict,
    buzzes: {} as NumberDict,
    readings: {} as BooleanDict,
    skips: {} as BooleanDict,
    judges: {} as BooleanDict,
    wagers: {} as NumberDict,
    canBuzz: false,
    canNextQ: false,
    dailyDoublePlayer: undefined as string | undefined,
  };
}

function getGameState(
  epNum?: string,
  airDate?: string,
  info?: string,
  jeopardy?: Question[],
  double?: Question[],
  final?: Question[],
) {
  return {
    jeopardy,
    double,
    final,
    answers: {} as StringDict,
    wagers: {} as NumberDict,
    board: {} as { [key: string]: RawQuestion },
    public: {
      epNum,
      airDate,
      info,
      scoring: 'standard',
      numCorrect: 0,
      numTotal: 0,
      board: {} as { [key: string]: Question },
      scores: {} as NumberDict, // player scores
      round: '', // jeopardy or double or final
      picker: undefined as string | undefined, // If null let anyone pick, otherwise last correct answer
      ...getPerQuestionState(),
    },
  };
}

async function speakText(text: string): Promise<ArrayBuffer> {
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "onyx",
    input: text,
  });
  
  return await response.arrayBuffer();
}

async function judgeAnswerWithOpenAI(
  participantAnswer: string,
  correctAnswer: string,
): Promise<boolean> {
  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are a Jeopardy judge. You must determine if answers are acceptable according to these rules:
            - Spelling doesn't have to be exact but should be phonetically similar
            - Articles (a, an, the) can be omitted or different
            - For people's names, last names alone are usually acceptable
            - Additional information beyond the correct answer is okay as long as it doesn't contradict the answer
            Respond with exactly "true" if acceptable or "false" if not acceptable.`,
        },
        {
          role: 'user',
          content: `Correct answer: "${correctAnswer}"
            Participant's answer: "${participantAnswer}"`,
        },
      ],
      model: 'gpt-4',
      temperature: 0.3,
      max_tokens: 3,
    });

    const judgedCorrect = completion.choices[0].message.content?.trim().toLowerCase() === 'true';

    // Log for monitoring
    console.log('[OpenAI Judge]', {
      correctAnswer,
      participantAnswer,
      judgedCorrect,
      rawResponse: completion.choices[0].message.content
    });

    return judgedCorrect;
  } catch (error) {
    console.error('Error judging answer with OpenAI:', error);
    return false;
  }
}

export class Jeopardy {
  public jpd: ReturnType<typeof getGameState>;
  private jpdSnapshot: ReturnType<typeof getGameState> | undefined;
  public roomId: string;
  private io: Server;
  private roster: User[];
  private room: Room;
  private playClueTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private questionAnswerTimeout: NodeJS.Timeout =
    undefined as unknown as NodeJS.Timeout;
  private wagerTimeout: NodeJS.Timeout = undefined as unknown as NodeJS.Timeout;

  constructor(
    io: Server,
    roomId: string,
    roster: User[],
    room: Room,
    gameData?: any,
  ) {
    this.io = io;
    this.roomId = roomId;
    this.roster = roster;
    this.room = room;

    if (gameData) {
      this.jpd = gameData;
      // Reconstruct the timeouts from the saved state
      if (this.jpd.public.questionEndTS) {
        const remaining = this.jpd.public.questionEndTS - Number(new Date());
        console.log('[QUESTIONENDTS]', remaining);
        this.setQuestionAnswerTimeout(remaining);
      }
      if (this.jpd.public.playClueEndTS) {
        const remaining = this.jpd.public.playClueEndTS - Number(new Date());
        console.log('[PLAYCLUEENDTS]', remaining);
        this.setPlayClueTimeout(remaining);
      }
      if (this.jpd.public.wagerEndTS) {
        const remaining = this.jpd.public.wagerEndTS - Number(new Date());
        console.log('[WAGERENDTS]', remaining);
        this.setWagerTimeout(remaining, this.jpd.public.wagerEndTS);
      }
    } else {
      this.jpd = getGameState(undefined, undefined, undefined, [], [], []);
    }

    this.io.of(this.roomId).on('connection', (socket: Socket) => {
      this.jpd.public.scores[socket.id] = 0;
      this.emitState();

      socket.on('JPD:cmdIntro', () => {
        this.io.of(this.roomId).emit('JPD:playIntro');
      });
      socket.on('JPD:init', () => {
        if (this.jpd) {
          socket.emit('JPD:state', this.jpd.public);
        }
      });
      socket.on('JPD:reconnect', (id: string) => {
        // Transfer old state to this player
        if (this.jpd.public.scores && this.jpd.public.scores[id]) {
          this.jpd.public.scores[socket.id] = this.jpd.public.scores[id];
          delete this.jpd.public.scores[id];
        }
        if (this.jpd.wagers && this.jpd.wagers[id]) {
          this.jpd.wagers[socket.id] = this.jpd.wagers[id];
          delete this.jpd.wagers[id];
        }
        if (this.jpd.public.buzzes && this.jpd.public.buzzes[id]) {
          this.jpd.public.buzzes[socket.id] = this.jpd.public.buzzes[id];
          delete this.jpd.public.buzzes[id];
        }
        if (this.jpd.public.dailyDoublePlayer === id) {
          this.jpd.public.dailyDoublePlayer = socket.id;
        }
        if (this.jpd.public.picker === id) {
          this.jpd.public.picker = socket.id;
        }
        this.emitState();
      });
      socket.on('JPD:start', (episode, filter, data) => {
        if (data && data.length > 1000000) {
          return;
        }
        this.loadEpisode(episode, filter, data);
      });
      socket.on('JPD:pickQ', (id: string) => {
        if (
          this.jpd.public.picker &&
          this.roster.find((p) => p.id === this.jpd.public.picker) &&
          this.jpd.public.picker !== socket.id
        ) {
          return;
        }
        if (this.jpd.public.currentQ) {
          return;
        }
        if (!this.jpd.public.board[id]) {
          return;
        }
        this.jpd.public.currentQ = id;
        this.jpd.public.currentValue = this.jpd.public.board[id].value;
        // check if it's a daily double
        if (this.jpd.board[id].dd && this.jpd.public.scoring !== 'coryat') {
          // if it is, don't show it yet, we need to collect wager info based only on category
          this.jpd.public.currentDailyDouble = true;
          this.jpd.public.dailyDoublePlayer = socket.id;
          this.jpd.public.waitingForWager = { [socket.id]: true };
          this.setWagerTimeout(15000);
          // Autobuzz the player, all others pass
          this.roster.forEach((p) => {
            if (p.id === socket.id) {
              this.jpd.public.buzzes[p.id] = Number(new Date());
            } else {
              this.jpd.public.submitted[p.id] = true;
            }
          });
          this.io.of(this.roomId).emit('JPD:playDailyDouble');
        } else {
          // Put Q in public state
          this.jpd.public.board[this.jpd.public.currentQ].question =
            this.jpd.board[this.jpd.public.currentQ].q;
          this.triggerPlayClue();
        }
        this.emitState();
      });
      socket.on('JPD:buzz', () => {
        if (!this.jpd.public.canBuzz) {
          return;
        }
        if (this.jpd.public.buzzes[socket.id]) {
          return;
        }
        this.jpd.public.buzzes[socket.id] = Number(new Date());
        this.emitState();
      });
      socket.on('JPD:answer', (question, answer) => {
        if (question !== this.jpd.public.currentQ) {
          return;
        }
        if (!this.jpd.public.questionDuration) {
          return;
        }
        if (answer && answer.length > 1024) {
          return;
        }
        console.log('[ANSWER]', socket.id, question, answer);
        if (answer) {
          this.jpd.answers[socket.id] = answer;
        }
        this.jpd.public.submitted[socket.id] = true;
        this.emitState();
        if (
          this.jpd.public.round !== 'final' &&
          this.roster.every((p) => p.id in this.jpd.public.submitted)
        ) {
          this.revealAnswer();
        }
      });

      socket.on('JPD:wager', (wager) => this.submitWager(socket.id, wager));
      socket.on('JPD:judge', (data) => this.doJudge(socket, data));
      socket.on('JPD:bulkJudge', (data) => {
        for (let i = 0; i < data.length; i++) {
          this.doJudge(socket, data[i]);
        }
      });
      socket.on('JPD:undo', () => {
        // Reset the game state to the last snapshot
        // Snapshot updates at each judging step
        if (this.jpdSnapshot) {
          this.jpd = JSON.parse(JSON.stringify(this.jpdSnapshot));
          this.emitState();
        }
      });
      socket.on('JPD:skipQ', () => {
        this.jpd.public.skips[socket.id] = true;
        if (
          this.jpd.public.canNextQ ||
          this.roster.every((p) => p.id in this.jpd.public.skips)
        ) {
          // If everyone votes to skip move to the next question
          // Or we are in the post-judging phase and can move on
          this.nextQuestion();
        } else {
          this.emitState();
        }
      });
      socket.on('JPD:scoring', (scoreMethod: string) => {
        this.jpd.public.scoring = scoreMethod;
        // Reset the picker if switching to coryat
        if (scoreMethod === 'coryat') {
          this.jpd.public.picker = undefined;
        }
        this.emitState();
      });
      socket.on('disconnect', () => {
        if (this.jpd && this.jpd.public) {
          // If player being judged leaves, skip their answer
          if (this.jpd.public.currentJudgeAnswer === socket.id) {
            // This is to run the rest of the code around judging
            this.judgeAnswer(undefined, {
              currentQ: this.jpd.public.currentQ,
              id: socket.id,
              correct: null,
            });
          }
          // If player who needs to submit wager leaves, submit 0
          if (
            this.jpd.public.waitingForWager &&
            this.jpd.public.waitingForWager[socket.id]
          ) {
            this.submitWager(socket.id, 0);
          }
        }
      });
    });
  }

  async playIntro() {
    // Create intro sequence messages
    const messages = [
      "This is Jeopardy!",
      "Here are today's contestants!"
    ];
  
    // Play intro messages
    for (const message of messages) {
      try {
        const audioBuffer = await speakText(message);
        this.io.of(this.roomId).emit('JPD:playIntroPhrase', audioBuffer);
        // Wait 2 seconds between phrases
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('Error in TTS for intro phrase:', error);
      }
    }
  
    // Introduce each contestant
    for (const player of this.roster) {
      const name = this.room.nameMap[player.id];
      try {
        // Generate a random location for flavor
        const locations = ["somewhere exciting", "parts unknown", "a mysterious location", 
                          "an undisclosed location", "a place of wonder", "somewhere out there"];
        const location = locations[Math.floor(Math.random() * locations.length)];
        
        const introText = `From ${location}, please welcome ${name}!`;
        const audioBuffer = await speakText(introText);
        
        this.io.of(this.roomId).emit('JPD:playIntroPhrase', audioBuffer);
        this.io.of(this.roomId).emit('JPD:showContestant', player.id);
        
        // Wait 3 seconds between contestant intros
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        console.error('Error in TTS for contestant intro:', error);
      }
    }
  
    try {
      const hostText = "And now, here is the host of Jeopardy: the Artificial clone of Alex Trebek!";
      const audioBuffer = await speakText(hostText);
      this.io.of(this.roomId).emit('JPD:playIntroPhrase', audioBuffer);
    } catch (error) {
      console.error('Error in TTS for host intro:', error);
    }
  
    // Wait for final message to complete
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Signal intro completion
    this.io.of(this.roomId).emit('JPD:introComplete');
  
    // Start the game and show categories
    await this.nextRound();
  }

  async loadEpisode(number: string, filter: string, custom: string) {
    console.log('[LOADEPISODE]', number, filter, Boolean(custom));
    let loadedData = null;
    if (custom) {
      try {
        const parse = Papa.parse(custom, { header: true });
        const typed = [];
        let round = '';
        let cat = '';
        let curX = 0;
        let curY = 0;
        for (let i = 0; i < parse.data.length; i++) {
          const d = parse.data[i];
          if (round !== d.round) {
            // Reset x and y to 1
            curX = 1;
            curY = 1;
          } else if (cat !== d.cat) {
            // Increment x, reset y to 1, new category
            curX += 1;
            curY = 1;
          } else {
            curY += 1;
          }
          round = d.round;
          cat = d.cat;
          let multiplier = 1;
          if (round === 'double') {
            multiplier = 2;
          } else if (round === 'final') {
            multiplier = 0;
          }
          if (d.q && d.a) {
            typed.push({
              round: d.round,
              cat: d.cat,
              q: d.q,
              a: d.a,
              dd: d.dd?.toLowerCase() === 'true',
              val: curY * 200 * multiplier,
              x: curX,
              y: curY,
            });
          }
        }
        loadedData = {
          airDate: new Date().toISOString().split('T')[0],
          epNum: 'Custom',
          jeopardy: typed.filter((d: any) => d.round === 'jeopardy'),
          double: typed.filter((d: any) => d.round === 'double'),
          final: typed.filter((d: any) => d.round === 'final'),
        };
        console.log(loadedData);
        redisCount('customGames');
      } catch (e) {
        console.warn(e);
      }
    } else {
      // Load question data into game
      let nums = Object.keys(jData);
      if (filter) {
        // Only load episodes with info matching the filter: kids, teen, college etc.
        nums = nums.filter(
          (num) =>
            (jData as any)[num].info && (jData as any)[num].info === filter,
        );
      }
      if (number === 'ddtest') {
        loadedData = jData['8000'];
        loadedData['jeopardy'] = loadedData['jeopardy'].filter(
          (q: any) => q.dd,
        );
      } else if (number === 'finaltest') {
        loadedData = jData['8000'];
      } else {
        if (!number) {
          // Random an episode
          number = nums[Math.floor(Math.random() * nums.length)];
        }
        loadedData = (jData as any)[number];
      }
    }
    if (loadedData) {
      redisCount('newGames');
      const { epNum, airDate, info, jeopardy, double, final } = loadedData;
      this.jpd = getGameState(epNum, airDate, info, jeopardy, double, final);
      if (number === 'finaltest') {
        this.jpd.public.round = 'double';
      }
      
      // Play intro before starting the game
      this.io.of(this.roomId).emit('JPD:startIntro');
      await this.playIntro();
    }
  }

  emitState() {
    this.io.of(this.roomId).emit('JPD:state', this.jpd.public);
  }

  async playCategories() {
    const categories = Object.values(this.jpd.public.board)
      .map(q => q.category)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('. ');
    
    try {
      const audioBuffer = await speakText(`Categories for ${this.jpd.public.round} round: ${categories}`);
      this.io.of(this.roomId).emit('JPD:playCategories', audioBuffer);
    } catch (error) {
      console.error('Error in TTS for categories:', error);
      this.io.of(this.roomId).emit('JPD:playCategories');
    }
  }

  resetAfterQuestion() {
    this.jpd.answers = {};
    this.jpd.wagers = {};
    clearTimeout(this.playClueTimeout);
    clearTimeout(this.questionAnswerTimeout);
    clearTimeout(this.wagerTimeout);
    this.jpd.public = { ...this.jpd.public, ...getPerQuestionState() };
  }

  nextQuestion() {
    // Show the correct answer in the game log
    this.room.addChatMessage(undefined, {
      id: '',
      cmd: 'answer',
      msg: this.jpd.public.currentAnswer,
    });
    // sort the player list by score
    this.roster.sort(
      (a, b) =>
        (this.jpd.public?.scores[b.id] || 0) -
        (this.jpd.public?.scores[a.id] || 0),
    );
    this.io.of(this.roomId).emit('roster', this.roster);
    delete this.jpd.public.board[this.jpd.public.currentQ];
    this.resetAfterQuestion();
    if (Object.keys(this.jpd.public.board).length === 0) {
      this.nextRound();
    } else {
      this.emitState();
      // TODO may want to introduce some delay here to make sure our state is updated before reading selection
      this.io.of(this.roomId).emit('JPD:playMakeSelection');
    }
  }

  nextRound() {
    this.resetAfterQuestion();
    // advance round counter
    if (this.jpd.public.round === 'jeopardy') {
      this.jpd.public.round = 'double';
      // If double, person with lowest score is picker
      // This is nlogn rather than n, but prob ok for small numbers of players
      if (this.jpd.public.scoring !== 'coryat') {
        const playersWithScores = this.roster.map((p) => ({
          id: p.id,
          score: this.jpd.public.scores[p.id] || 0,
        }));
        playersWithScores.sort((a, b) => a.score - b.score);
        this.jpd.public.picker = playersWithScores[0]?.id;
      }
    } else if (this.jpd.public.round === 'double') {
      this.jpd.public.round = 'final';
      const now = Number(new Date());
      this.jpd.public.waitingForWager = {};
      this.roster.forEach((p) => {
        this.jpd.public.waitingForWager![p.id] = true;
      });
      this.setWagerTimeout(30000);
      // autopick the question
      this.jpd.public.currentQ = '1_1';
      // autobuzz the players in ascending score order
      let playerIds = this.roster.map((p) => p.id);
      playerIds.sort(
        (a, b) =>
          Number(this.jpd.public.scores[a] || 0) -
          Number(this.jpd.public.scores[b] || 0),
      );
      playerIds.forEach((pid) => {
        this.jpd.public.buzzes[pid] = now;
      });
      // Play the category sound
      this.io.of(this.roomId).emit('JPD:playRightanswer');
    } else if (this.jpd.public.round === 'final') {
      this.jpd.public.round = 'end';
      // Log the results
      const scores = Object.entries(this.jpd.public.scores);
      scores.sort((a, b) => b[1] - a[1]);
      const scoresNames = scores.map((score) => [
        this.room.nameMap[score[0]],
        score[1],
      ]);
      redis?.lpush('jpd:results', JSON.stringify(scoresNames));
    } else {
      this.jpd.public.round = 'jeopardy';
    }
    if (
      this.jpd.public.round === 'jeopardy' ||
      this.jpd.public.round === 'double' ||
      this.jpd.public.round === 'final'
    ) {
      this.jpd.board = constructBoard((this.jpd as any)[this.jpd.public.round]);
      this.jpd.public.board = constructPublicBoard(
        (this.jpd as any)[this.jpd.public.round],
      );
      if (Object.keys(this.jpd.public.board).length === 0) {
        this.nextRound();
      }
    }
    this.emitState();
    if (
      this.jpd.public.round === 'jeopardy' ||
      this.jpd.public.round === 'double'
    ) {
      console.log('[PLAYCATEGORIES]', this.jpd.public.round);
      this.playCategories();
    }
  }

  unlockAnswer(duration = 15000) {
    const durationMs = Number(duration);
    this.jpd.public.questionDuration = durationMs;
    this.jpd.public.questionEndTS = Number(new Date()) + durationMs;
    this.setQuestionAnswerTimeout(duration);
  }

  setQuestionAnswerTimeout(durationMs: number) {
    this.questionAnswerTimeout = setTimeout(() => {
      if (this.jpd.public.round !== 'final') {
        this.io.of(this.roomId).emit('JPD:playTimesUp');
      }
      this.revealAnswer();
    }, durationMs);
  }
  
  // In the Jeopardy class, modify the revealAnswer method to handle scoring order correctly

  async revealAnswer() {
    this.jpd.public.numTotal += 1;
    clearTimeout(this.questionAnswerTimeout);
    this.jpd.public.questionDuration = 0;
    this.jpd.public.questionEndTS = 0;

    // Add empty answers for anyone who buzzed but didn't submit anything
    Object.keys(this.jpd.public.buzzes).forEach((key) => {
      if (!this.jpd.answers[key]) {
        this.jpd.answers[key] = '';
      }
    });

    this.jpd.public.canBuzz = false;
    this.jpd.public.answers = { ...this.jpd.answers };
    this.jpd.public.currentAnswer = this.jpd.board[this.jpd.public.currentQ]?.a;

    // Sort answers by buzz time
    const submittedAnswers = Object.entries(this.jpd.answers)
      .sort((a, b) => (this.jpd.public.buzzes[a[0]] || 0) - (this.jpd.public.buzzes[b[0]] || 0));
    
    let hasCorrectAnswer = false;
    let firstAnswer = true;
    
    for (const [playerId, answer] of submittedAnswers) {
      try {
        const isCorrect = await judgeAnswerWithOpenAI(
          answer.toLowerCase(),
          this.jpd.public.currentAnswer?.toLowerCase() || '',
        );

        // Store the judgment result
        this.jpd.public.judges[playerId] = isCorrect;

        // Update scores only if:
        // 1. This is Final Jeopardy (all answers count), or
        // 2. Using Coryat scoring (all answers count), or
        // 3. This is the first correct answer
        const shouldUpdateScore = 
          this.jpd.public.round === 'final' || 
          this.jpd.public.scoring === 'coryat' ||
          (isCorrect && !hasCorrectAnswer);

        if (isCorrect) {
          console.log('[AUTO-JUDGE] Correct answer for player:', playerId);
          this.jpd.public.numCorrect += 1;
          
          if (shouldUpdateScore) {
            this.jpd.public.scores[playerId] = (this.jpd.public.scores[playerId] || 0) + 
              (this.jpd.wagers[playerId] || this.jpd.public.currentValue);
          }

          // Set picker for next question if not coryat scoring and this is the first correct answer
          if (!hasCorrectAnswer && this.jpd.public.scoring !== 'coryat') {
            this.jpd.public.picker = playerId;
          }

          hasCorrectAnswer = true;

          // Play correct answer sound only for the first correct answer
          if (firstAnswer) {
            try {
              const audioBuffer = await getRandomPhrase(true);
              this.io.of(this.roomId).emit('JPD:playResponsePhrase', audioBuffer);
              firstAnswer = false;
            } catch (error) {
              console.error('Error playing correct phrase:', error);
            }
          }
        } else {
          console.log('[AUTO-JUDGE] Incorrect answer for player:', playerId);
          
          // Always subtract points for wrong answers in Final Jeopardy or if it's the first answer
          if (shouldUpdateScore) {
            this.jpd.public.scores[playerId] = (this.jpd.public.scores[playerId] || 0) - 
              (this.jpd.wagers[playerId] || this.jpd.public.currentValue);
          }
            
          // Play incorrect answer sound only for the first answer if no correct answers yet
          if (firstAnswer && !hasCorrectAnswer) {
            try {
              const audioBuffer = await getRandomPhrase(false);
              this.io.of(this.roomId).emit('JPD:playResponsePhrase', audioBuffer);
              firstAnswer = false;
            } catch (error) {
              console.error('Error playing incorrect phrase:', error);
            }
          }
        }

        // Log the judgment
        console.log('[AUTO-JUDGE] Player:', playerId, 'Score:', this.jpd.public.scores[playerId]);
      } catch (error) {
        console.error('[AUTO-JUDGE] Error judging answer for player:', playerId, error);
      }
    }

    // Move to next question
    this.jpd.public.canNextQ = true;
    this.jpdSnapshot = JSON.parse(JSON.stringify(this.jpd));
    this.emitState();

    // If not final round or coryat scoring and we have a correct answer, move to next question
    const allowMultipleCorrect =
      this.jpd.public.round === 'final' || this.jpd.public.scoring === 'coryat';

    if (!allowMultipleCorrect && hasCorrectAnswer) {
      this.nextQuestion();
    }
  }

  advanceJudging() {
    console.log('[ADVANCEJUDGING]', this.jpd.public.currentJudgeAnswerIndex);
    if (this.jpd.public.currentJudgeAnswerIndex === undefined) {
      this.jpd.public.currentJudgeAnswerIndex = 0;
    } else {
      this.jpd.public.currentJudgeAnswerIndex += 1;
    }
    this.jpd.public.currentJudgeAnswer = Object.keys(this.jpd.public.buzzes)[
      this.jpd.public.currentJudgeAnswerIndex
    ];
    this.jpd.public.wagers[this.jpd.public.currentJudgeAnswer] =
      this.jpd.wagers[this.jpd.public.currentJudgeAnswer];
    this.jpd.public.answers[this.jpd.public.currentJudgeAnswer] =
      this.jpd.answers[this.jpd.public.currentJudgeAnswer];

    // If the current judge player isn't connected, advance again
    if (
      this.jpd.public.currentJudgeAnswer &&
      !this.roster.find((p) => p.id === this.jpd.public.currentJudgeAnswer)
    ) {
      console.log(
        '[ADVANCEJUDGING] player not found, moving on:',
        this.jpd.public.currentJudgeAnswer,
      );
      this.advanceJudging();
    }
  }

  doJudge(
    socket: Socket,
    data: { currentQ: string; id: string; correct: boolean | null },
  ) {
    const answer = this.jpd.public.currentAnswer;
    const submitted = this.jpd.public.answers[data.id];
    const success = this.judgeAnswer(socket, data);
    if (success) {
      if (data.correct && redis) {
        // If the answer was judged correct and non-trivial (equal lowercase), log it for analysis
        if (answer?.toLowerCase() !== submitted?.toLowerCase()) {
          redis.lpush('jpd:nonTrivialJudges', `${answer},${submitted},${1}`);
          // redis.ltrim('jpd:nonTrivialJudges', 0, 100000);
        }
      }
    }
  }

  judgeAnswer(
    socket: Socket | undefined,
    {
      currentQ,
      id,
      correct,
    }: { currentQ: string; id: string; correct: boolean | null },
  ) {
    if (id in this.jpd.public.judges) {
      // Already judged this player
      return false;
    }
    if (currentQ !== this.jpd.public.currentQ) {
      // Not judging the right question
      return false;
    }
    if (this.jpd.public.currentJudgeAnswer === undefined) {
      // Not in judging step
      return false;
    }
    this.jpd.public.judges[id] = correct;
    console.log('[JUDGE]', id, correct);
    // Currently anyone can pick the correct answer
    // Can turn this into a vote or make a non-player the host
    // MAYBE attempt auto-judging using fuzzy string match
    if (!this.jpd.public.scores[id]) {
      this.jpd.public.scores[id] = 0;
    }
    if (correct === true) {
      this.jpd.public.numCorrect += 1;
      this.jpd.public.scores[id] +=
        this.jpd.public.wagers[id] || this.jpd.public.currentValue;
      if (this.jpd.public.scoring !== 'coryat') {
        // Correct answer is next picker
        this.jpd.public.picker = id;
      }
    }
    if (correct === false) {
      this.jpd.public.scores[id] -=
        this.jpd.public.wagers[id] || this.jpd.public.currentValue;
    }
    // If null, don't change scores

    if (socket && correct != null) {
      const msg = {
        id: socket.id,
        cmd: 'judge',
        msg: JSON.stringify({
          id: id,
          answer: this.jpd.public.answers[id],
          correct: correct,
        }),
      };
      this.room.addChatMessage(socket, msg);
    }

    this.advanceJudging();

    const allowMultipleCorrect =
      this.jpd.public.round === 'final' || this.jpd.public.scoring === 'coryat';
    if (
      (!allowMultipleCorrect && correct) ||
      !this.jpd.public.currentJudgeAnswer
    ) {
      this.jpd.public.canNextQ = true;
      this.nextQuestion();
    } else {
      this.emitState();
    }
    return correct !== null;
  }

  submitWager(id: string, wager: number) {
    if (id in this.jpd.wagers) {
      return;
    }
    // User setting a wager for DD or final
    // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
    let maxWager = 0;
    let minWager = 5;
    if (this.jpd.public.round === 'jeopardy') {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 1000);
    } else if (this.jpd.public.round === 'double') {
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 2000);
    } else if (this.jpd.public.round === 'final') {
      minWager = 0;
      maxWager = Math.max(this.jpd.public.scores[id] || 0, 0);
    }
    let numWager = Number(wager);
    if (Number.isNaN(Number(wager))) {
      numWager = minWager;
    } else {
      numWager = Math.min(Math.max(numWager, minWager), maxWager);
    }
    console.log('[WAGER]', id, wager, numWager);
    if (id === this.jpd.public.dailyDoublePlayer && this.jpd.public.currentQ) {
      this.jpd.wagers[id] = numWager;
      this.jpd.public.wagers[id] = numWager;
      this.jpd.public.waitingForWager = undefined;
      if (this.jpd.public.board[this.jpd.public.currentQ]) {
        this.jpd.public.board[this.jpd.public.currentQ].question =
          this.jpd.board[this.jpd.public.currentQ]?.q;
      }
      this.triggerPlayClue();
      this.emitState();
    }
    if (this.jpd.public.round === 'final' && this.jpd.public.currentQ) {
      // store the wagers privately until everyone's made one
      this.jpd.wagers[id] = numWager;
      if (this.jpd.public.waitingForWager) {
        delete this.jpd.public.waitingForWager[id];
      }
      if (Object.keys(this.jpd.public.waitingForWager ?? {}).length === 0) {
        // if final, reveal clue if all players made wager
        this.jpd.public.waitingForWager = undefined;
        if (this.jpd.public.board[this.jpd.public.currentQ]) {
          this.jpd.public.board[this.jpd.public.currentQ].question =
            this.jpd.board[this.jpd.public.currentQ]?.q;
        }
        this.triggerPlayClue();
      }
      this.emitState();
    }
  }

  setWagerTimeout(duration: number, endTS?: number) {
    this.jpd.public.wagerEndTS = endTS ?? Number(new Date()) + duration;
    this.jpd.public.wagerDuration = duration;
    this.wagerTimeout = setTimeout(() => {
      Object.keys(this.jpd.public.waitingForWager ?? {}).forEach((id) => {
        this.submitWager(id, 0);
      });
    }, duration);
  }

  async triggerPlayClue() {
    clearTimeout(this.wagerTimeout);
    this.jpd.public.wagerDuration = 0;
    const clue = this.jpd.public.board[this.jpd.public.currentQ];
    
    try {
        if (clue && clue.question) {
            const audioBuffer = await speakText(clue.question.replace(/^\(.*\)/, '').replace(/_+/g, ' blank '));
            this.io.of(this.roomId).emit('JPD:playClue', this.jpd.public.currentQ, clue.question, audioBuffer);
        } else {
            this.io.of(this.roomId).emit('JPD:playClue', this.jpd.public.currentQ, '');
        }
    } catch (error) {
        console.error('Error in TTS for clue:', error);
        this.io.of(this.roomId).emit('JPD:playClue', this.jpd.public.currentQ, clue?.question || '');
    }

    let speakingTime = 0;
    if (clue && clue.question) {
        // Allow some time for reading the text, based on content
        // Count syllables in text, assume speaking rate of 4 syll/sec
        const syllCountArr = clue.question
            // Remove parenthetical starts and blanks
            .replace(/^\(.*\)/, '')
            .replace(/_+/g, ' blank ')
            .split(' ')
            .map((word: string) => syllableCount(word));
        const totalSyll = syllCountArr.reduce((a: number, b: number) => a + b, 0);
        // Minimum 1 second speaking time
        speakingTime = Math.max((totalSyll / 4) * 1000, 1000);
        console.log('[TRIGGERPLAYCLUE]', clue.question, totalSyll, speakingTime);
        this.jpd.public.playClueDuration = speakingTime;
        this.jpd.public.playClueEndTS = Number(new Date()) + speakingTime;
    }
    
    this.setPlayClueTimeout(speakingTime);
}

  setPlayClueTimeout(duration: number) {
    this.playClueTimeout = setTimeout(() => {
      this.playClueDone();
    }, duration);
  }

  playClueDone() {
    console.log('[PLAYCLUEDONE]');
    clearTimeout(this.playClueTimeout);
    this.jpd.public.playClueDuration = 0;
    this.jpd.public.playClueEndTS = 0;
    this.jpd.public.buzzUnlockTS = Number(new Date());

    if (this.jpd.public.currentDailyDouble) {
      this.unlockAnswer();
    } else if (this.jpd.public.round === 'final') {
      this.unlockAnswer(30000);
      // Play final jeopardy music
      this.io.of(this.roomId).emit('JPD:playFinalJeopardy');
    } else {
      this.jpd.public.canBuzz = true;
      this.unlockAnswer();
    }
    this.emitState();
  }

  toJSON() {
    return this.jpd;
  }
}
