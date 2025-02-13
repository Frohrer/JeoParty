import React, { useState } from 'react';
import {
  Button,
  Label,
  Input,
  Icon,
  Dropdown,
  Popup,
  Modal,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  TableHeaderCell,
} from 'semantic-ui-react';
import './Jeopardy.css';
import { getDefaultPicture, getColorHex, shuffle, getColor } from '../../utils';
import { Socket } from 'socket.io';
import ReactMarkdown from 'react-markdown';

const scoringOptions = [
  {
    key: 'standard',
    value: 'standard',
    text: 'Standard',
    title:
      'Same as the TV show. First correct answer scores the points. Incorrect answers before the correct answer lose points. The last correct answer picks the next question.',
  },
  {
    key: 'coryat',
    value: 'coryat',
    text: 'Coryat',
    title:
      'All players get a chance to score/lose points. All players can pick the next question. Daily Doubles are disabled.',
  },
  {
    key: 'coop',
    value: 'coop',
    text: 'Co-Op',
    title:
      'Point values are ignored. Score is the same for all players and shows how many questions had a correct answer.',
  },
];

const dailyDouble = new Audio('/jeopardy/jeopardy-daily-double.mp3');
const boardFill = new Audio('/jeopardy/jeopardy-board-fill.mp3');
const think = new Audio('/jeopardy/jeopardy-think.mp3');
const timesUp = new Audio('/jeopardy/jeopardy-times-up.mp3');
const rightAnswer = new Audio('/jeopardy/jeopardy-rightanswer.mp3');

export class Jeopardy extends React.Component<{
  socket: Socket;
  participants: User[];
  nameMap: StringDict;
  pictureMap: StringDict;
}> {
  public state = {
    game: null as any,
    isIntroPlaying: false,
    currentIntroPlayer: null as string | null,
    localAnswer: '',
    localWager: '',
    localAnswerSubmitted: false,
    localWagerSubmitted: false,
    localEpNum: '',
    categoryMask: Array(6).fill(true),
    categoryReadTime: 0,
    clueMask: {} as any,
    readingDisabled: false,
    buzzFrozen: false,
    showCustomModal: false,
    showJudgingModal: false,
  };
  buzzLock = 0;
  private introVideo: HTMLVideoElement | null = null;
  private introMusic: HTMLAudioElement | null = null;
  async componentDidMount() {
    window.speechSynthesis.getVoices();

    document.onkeydown = this.onKeydown;

    this.setState({
      readingDisabled: Boolean(
        window.localStorage.getItem('jeopardy-readingDisabled'),
      ),
    });
    this.props.socket.on('JPD:startIntro', () => {
      console.log('Starting intro sequence');
      this.setState({ isIntroPlaying: true });
      
      // Clear any existing content
      const introDiv = document.getElementById('intro');
      if (introDiv) {
        introDiv.innerHTML = '';
        
        // Create and set up video element
        this.introVideo = document.createElement('video');
        this.introVideo.muted = false; // Allow sound
        this.introVideo.src = '/jeopardy/jeopardy-intro-video.mp4';
        this.introVideo.style.width = '100%';
        this.introVideo.style.height = '100%';
        this.introVideo.style.backgroundColor = '#000000';
        introDiv.appendChild(this.introVideo);
        
        // Create and set up audio element
        this.introMusic = new Audio('/jeopardy/jeopardy-intro-full.ogg');
        this.introMusic.volume = 0.5;
        
        // Play both video and audio
        Promise.all([
          this.introVideo.play(),
          this.introMusic.play()
        ]).catch(error => {
          console.error('Error playing intro media:', error);
        });
      }
    });
  
    this.props.socket.on('JPD:introComplete', () => {
      console.log('Completing intro sequence');
      // Stop and cleanup intro media
      if (this.introVideo) {
        this.introVideo.pause();
        this.introVideo.remove();
        this.introVideo = null;
      }
      if (this.introMusic) {
        this.introMusic.pause();
        this.introMusic = null;
      }
      
      const introDiv = document.getElementById('intro');
      if (introDiv) {
        introDiv.innerHTML = '';
      }
      
      this.setState({ 
        isIntroPlaying: false, 
        currentIntroPlayer: null 
      });
    });
  
    this.props.socket.on('JPD:playIntroPhrase', async (audioBuffer: ArrayBuffer) => {
      if (audioBuffer) {
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        await audio.play();
      }
    });
  
    this.props.socket.on('JPD:showContestant', (playerId: string) => {
      this.setState({ currentIntroPlayer: playerId });
    });
  
    this.props.socket.emit('JPD:init');
    this.props.socket.on('JPD:state', (game: any) => {
      this.setState({ game, localEpNum: game.epNum });
    });
    this.props.socket.on('JPD:playIntro', () => {
      this.playIntro();
    });
    this.props.socket.on('JPD:playTimesUp', () => {
      timesUp.play();
    });
    this.props.socket.on('JPD:playDailyDouble', () => {
      dailyDouble.volume = 0.5;
      dailyDouble.play();
    });
    this.props.socket.on('JPD:playFinalJeopardy', async () => {
      think.volume = 0.5;
      think.play();
    });
    this.props.socket.on('JPD:playRightanswer', () => {
      rightAnswer.play();
    });
    this.props.socket.on('JPD:playResponsePhrase', async (audioBuffer?: ArrayBuffer) => {
      if (audioBuffer) {
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        await audio.play();
      }
    });
    // this.props.socket.on('JPD:playMakeSelection', () => {
    //   if (this.state.game.picker) {
    //     const selectionText = [
    //       'Make a selection, {name}',
    //       'You have command of the board, {name}',
    //       'Pick a clue, {name}',
    //       'Select a category, {name}',
    //       'Go again, {name}',
    //     ];
    //     const random =p
    //       selectionText[Math.floor(Math.random() * selectionText.length)];
    //     this.sayText(
    //       random.replace('{name}', this.props.nameMap[this.state.game.picker])
    //     );
    //   }
    // });
    this.props.socket.on('JPD:playClue', async (qid: string, text: string, audioBuffer?: ArrayBuffer) => {
      this.setState({
        localAnswer: '',
        localWager: '',
        localWagerSubmitted: false,
        localAnswerSubmitted: false,
      });
    
      if (audioBuffer) {
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        await audio.play();
      }
    });

    this.props.socket.on('JPD:playCategories', async (audioBuffer?: ArrayBuffer) => {
      const now = Number(new Date());
      const clueMask: any = {};
      const clueMaskOrder = [];
      for (let i = 1; i <= 6; i++) {
        for (let j = 1; j <= 5; j++) {
          clueMask[`${i}_${j}`] = true;
          clueMaskOrder.push(`${i}_${j}`);
        }
      }
      this.setState({
        categoryMask: Array(6).fill(false),
        categoryReadTime: now,
        clueMask,
      });
    
      boardFill.play();
      
      // Play TTS audio if provided
      if (audioBuffer) {
        const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        await audio.play();
      }
    
      // Visual board fill animation
      shuffle(clueMaskOrder);
      const clueSets = [];
      for (let i = 0; i < clueMaskOrder.length; i += 5) {
        clueSets.push(clueMaskOrder.slice(i, i + 5));
      }
      for (let i = 0; i < clueSets.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        clueSets[i].forEach((clue) => delete this.state.clueMask[clue]);
        this.setState({ clueMask: this.state.clueMask });
      }
    
      // Reveal categories visually
      for (let i = 0; i < this.state.categoryMask.length; i++) {
        if (this.state.categoryReadTime !== now) continue;
        let newMask = [...this.state.categoryMask];
        newMask[i] = true;
        this.setState({ categoryMask: newMask });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.onKeydown);
    if (this.introVideo) {
      this.introVideo.pause();
      this.introVideo = null;
    }
    if (this.introMusic) {
      this.introMusic.pause();
      this.introMusic = null;
    }
  }

  async componentDidUpdate(prevProps: any, prevState: any) {
    if (!prevState.game?.currentQ && this.state.game?.currentQ) {
      // Run growing clue animation
      const clue = document.getElementById(
        'clueContainerContainer',
      ) as HTMLElement;
      const board = document.getElementById('board') as HTMLElement;
      const box = document.getElementById(
        this.state.game?.currentQ,
      ) as HTMLElement;
      clue.style.position = 'absolute';
      clue.style.left = box.offsetLeft + 'px';
      clue.style.top = box.offsetTop + 'px';
      setTimeout(() => {
        clue.style.left = board.scrollLeft + 'px';
        clue.style.top = '0px';
        clue.style.transform = 'scale(1)';
      }, 1);
    }
  }

  onKeydown = (e: any) => {
    if (!document.activeElement || document.activeElement.tagName === 'BODY') {
      if (e.key === ' ') {
        e.preventDefault();
        this.onBuzz();
      }
      if (e.key === 'p') {
        e.preventDefault();
        if (this.state.game.canBuzz) {
          this.submitAnswer(null);
        }
      }
    }
  };

  newGame = async (
    episode: string | null,
    filter: string | null,
    customGame?: string,
  ) => {
    this.setState({ game: null });
    // optionally send an episode number
    this.props.socket.emit('JPD:start', episode, filter, customGame);
  };

  changeScoring = (scoreMethod: string) => {
    this.props.socket.emit('JPD:scoring', scoreMethod);
  };

  customGame = () => {
    // Create an input element
    const inputElement = document.createElement('input');

    // Set its type to file
    inputElement.type = 'file';

    // Set accept to the file types you want the user to select.
    // Include both the file extension and the mime type
    // inputElement.accept = accept;

    // set onchange event to call callback when user has selected file
    inputElement.addEventListener('change', () => {
      const file = inputElement.files![0];
      // Read the file
      const reader = new FileReader();
      reader.readAsText(file);
      reader.onload = (e) => {
        let content = e.target?.result;
        this.newGame(null, null, content as string);
        this.setState({ showCustomModal: false });
      };
    });

    // dispatch a click event to open the file dialog
    inputElement.dispatchEvent(new MouseEvent('click'));
  };

  playIntro = async () => {
    this.setState({ isIntroPlaying: true });
    document.getElementById('intro')!.innerHTML = '';
    let introVideo = document.createElement('video');
    let introMusic = new Audio('/jeopardy/jeopardy-intro-full.ogg');
    document.getElementById('intro')?.appendChild(introVideo);
    introVideo.muted = true;
    introVideo.src = '/jeopardy/jeopardy-intro-video.mp4';
    introVideo.play();
    introVideo.style.width = '100%';
    introVideo.style.height = '100%';
    introVideo.style.backgroundColor = '#000000';
    introMusic.volume = 0.5;
    introMusic.play();
    setTimeout(async () => {
      await this.sayText('This is Jeopardy!');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await this.sayText("Here are today's contestants.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (let i = 0; i < this.props.participants.length; i++) {
        const p = this.props.participants[i];
        const name = this.props.nameMap[p.id];
        const player = document.createElement('img');
        player.src =
          getDefaultPicture(this.props.nameMap[p.id], getColorHex(p.id)) ||
          this.props.pictureMap[p.id];
        player.style.width = '200px';
        player.style.height = '200px';
        player.style.position = 'absolute';
        player.style.margin = 'auto';
        player.style.top = '0px';
        player.style.bottom = '0px';
        player.style.left = '0px';
        player.style.right = '0px';
        document.getElementById('intro')!.appendChild(player);
        // maybe we can look up the location by IP?
        await this.sayText('A person from somewhere, ' + name);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        document.getElementById('intro')!.removeChild(player);
      }
      await this.sayText(
        'And now, here is the host of Jeopardy: the Artifical clone of Alex Trebec stuck in a computer!'
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      introMusic.pause();
      introVideo.pause();
      introVideo = null as any;
      introMusic = null as any;
      document.getElementById('intro')!.innerHTML = '';
      this.setState({ isIntroPlaying: false });
    }, 10000);
  };

  sayText = async (text: string) => {
    if (this.state.readingDisabled) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    if (text.startsWith('!')) {
      // This is probably markdown
      return;
    }
    let isIOS = /iPad|iPhone|iPod/.test(navigator.platform);
    if (isIOS) {
      // on iOS speech synthesis just never returns
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    await new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const utterThis = new SpeechSynthesisUtterance(text);
      // let retryCount = 0;
      // while (speechSynthesis.getVoices().length === 0 && retryCount < 3) {
      //   retryCount += 1;
      //   await new Promise((resolve) => setTimeout(resolve, 500));
      // }
      let voices = window.speechSynthesis.getVoices();
      let target = voices.find(
        (voice) => voice.name === 'Google UK English Male',
      );
      if (target) {
        utterThis.voice = target;
      }
      window.speechSynthesis.speak(utterThis);
      utterThis.onend = resolve;
      utterThis.onerror = resolve;
    });
  };

  pickQ = (id: string) => {
    this.props.socket.emit('JPD:pickQ', id);
  };

  submitWager = () => {
    this.props.socket.emit('JPD:wager', this.state.localWager);
    this.setState({ localWager: '', localWagerSubmitted: true });
  };

  submitAnswer = (answer = null) => {
    if (!this.state.localAnswerSubmitted) {
      this.props.socket.emit(
        'JPD:answer',
        this.state.game?.currentQ,
        answer || this.state.localAnswer,
      );
      this.setState({ localAnswer: '', localAnswerSubmitted: true });
    }
  };

  judgeAnswer = (id: string, correct: boolean | null) => {
    this.props.socket.emit('JPD:judge', { currentQ: this.state.game.currentQ, id, correct });
  };

  bulkJudgeAnswer = (data: {id: string, correct: boolean | null}[]) => {
    this.props.socket.emit('JPD:bulkJudge', data.map(d => ({...d, currentQ: this.state.game.currentQ })));
  };

  getCategories = () => {
    const game = this.state.game;
    if (!game || !game.board) {
      return [];
    }
    let categories: string[] = Array(6).fill('');
    Object.keys(game.board).forEach((key) => {
      const col = Number(key.split('_')[0]) - 1;
      categories[col] = game.board[key].category;
    });
    return categories;
  };

  getWinners = () => {
    const max =
      Math.max(...Object.values<number>(this.state.game?.scores || {})) || 0;
    return this.props.participants
      .filter((p) => (this.state.game.scores[p.id] || 0) === max)
      .map((p) => p.id);
  };

  getBuzzOffset = (id: string) => {
    if (!this.state.game?.buzzUnlockTS) {
      return 0;
    }
    return this.state.game?.buzzes[id] - this.state.game?.buzzUnlockTS;
  };

  onBuzz = () => {
    const game = this.state.game;
    if (game.canBuzz && !this.buzzLock && !this.state.buzzFrozen) {
      this.props.socket.emit('JPD:buzz');
    } else {
      // Freeze the buzzer for 0.25 seconds
      // setState takes a little bit, so also set a local var to prevent spam
      const now = Date.now();
      this.buzzLock = now;
      this.setState({ buzzFrozen: true });
      setTimeout(() => {
        if (this.buzzLock === now) {
          this.setState({ buzzFrozen: false });
          this.buzzLock = 0;
        }
      }, 250);
    }
  };

  render() {
    const game = this.state.game;
    const categories = this.getCategories();
    const participants = this.props.participants;
    return (
      <>
        {this.state.showCustomModal && (
          <Modal open onClose={() => this.setState({ showCustomModal: false })}>
            <Modal.Header>Custom Game</Modal.Header>
            <Modal.Content>
              <Modal.Description>
                <div>
                  You can create and play a custom game by uploading a data
                  file. Download the example and customize with your own
                  questions and answers.
                  <div>
                    <Button
                      color="orange"
                      icon
                      labelPosition="left"
                      href={`./example.csv`}
                      download="example.csv"
                    >
                      <Icon name="download" />
                      Download Example .csv
                    </Button>
                  </div>
                </div>
                <hr />
                <div>Once you're done, upload your file:</div>
                <div>
                  <Button
                    onClick={() => this.customGame()}
                    icon
                    labelPosition="left"
                    color="purple"
                  >
                    <Icon name="upload" />
                    Upload
                  </Button>
                </div>
              </Modal.Description>
            </Modal.Content>
          </Modal>
        )}
        {this.state.showJudgingModal && (
          <BulkJudgeModal
            game={game}
            nameMap={this.props.nameMap}
            participants={participants}
            bulkJudge={this.bulkJudgeAnswer}
            onClose={() => this.setState({ showJudgingModal: false })}
            getBuzzOffset={this.getBuzzOffset}
          />
        )}
        <div
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {
            <React.Fragment>
              {
                <div style={{ display: 'flex', flexGrow: 1 }}>
                  <div
                    id="board"
                    className={`board ${
                      this.state.game?.currentQ ? 'currentQ' : ''
                    }`}
                  >
                    {this.state.isIntroPlaying && (
                      <div id="intro">
                        {this.state.currentIntroPlayer && (
                          <img
                            src={
                              getDefaultPicture(
                                this.props.nameMap[this.state.currentIntroPlayer],
                                getColorHex(this.state.currentIntroPlayer)
                              ) ||
                              this.props.pictureMap[this.state.currentIntroPlayer]
                            }
                            style={{
                              width: '200px',
                              height: '200px',
                              position: 'absolute',
                              margin: 'auto',
                              top: '0px',
                              bottom: '0px',
                              left: '0px',
                              right: '0px',
                              zIndex: 2 
                            }}
                            alt={this.props.nameMap[this.state.currentIntroPlayer]}
                          />
                        )}
                      </div>
                    )}
                    {categories.map((cat, i) => (
                      <div key={i} className="category box">
                        {this.state.categoryMask[i] ? cat : ''}
                      </div>
                    ))}
                    {Array.from(Array(5)).map((_, i) => {
                      return (
                        <React.Fragment key={i}>
                          {categories.map((cat, j) => {
                            const id = `${j + 1}_${i + 1}`;
                            const clue = game.board[id];
                            return (
                              <div
                                key={id}
                                id={id}
                                onClick={
                                  clue ? () => this.pickQ(id) : undefined
                                }
                                className={`${clue ? 'value' : ''} box`}
                              >
                                {!this.state.clueMask[id] && clue
                                  ? clue.value
                                  : ''}
                              </div>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                    {game && Boolean(game.currentQ) && (
                      <div
                        id="clueContainerContainer"
                        className="clueContainerContainer"
                      >
                        <div
                          id="clueContainer"
                          className={`clueContainer ${
                            game.currentDailyDouble && game.waitingForWager
                              ? 'dailyDouble'
                              : ''
                          }`}
                        >
                          <div className="category" style={{ height: '30px' }}>
                            {game.board[game.currentQ] &&
                              game.board[game.currentQ].category}
                          </div>
                          <div className="category" style={{ height: '30px' }}>
                            {Boolean(game.currentValue) && game.currentValue}
                          </div>
                          {
                            <div className={`clue`}>
                              <ReactMarkdown
                                components={{
                                  //This custom renderer changes how images are rendered
                                  //we use it to constrain the max width of an image to its container
                                  img: ({
                                    alt,
                                    src,
                                    title,
                                  }: {
                                    alt?: string;
                                    src?: string;
                                    title?: string;
                                  }) => (
                                    <img
                                      alt={alt}
                                      src={src}
                                      title={title}
                                      style={{
                                        maxWidth: '80%',
                                        maxHeight: '350px',
                                      }}
                                    />
                                  ),
                                }}
                              >
                                {game.board[game.currentQ] &&
                                  game.board[game.currentQ].question}
                              </ReactMarkdown>
                            </div>
                          }
                          <div className="" style={{ height: '60px' }}>
                            {!game.currentAnswer &&
                            !game.buzzes[this.props.socket.id] &&
                            !game.submitted[this.props.socket.id] &&
                            !game.currentDailyDouble &&
                            game.round !== 'final' ? (
                              <div style={{ display: 'flex' }}>
                                <Button
                                  disabled={this.state.buzzFrozen}
                                  color={game.canBuzz ? 'green' : 'grey'}
                                  size="huge"
                                  onClick={this.onBuzz}
                                  icon
                                  labelPosition="left"
                                >
                                  <Icon
                                    name={game.canBuzz ? 'lightbulb' : 'lock'}
                                  />
                                  Buzz
                                </Button>
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: '0px',
                                    right: '0px',
                                    zIndex: 1,
                                  }}
                                >
                                  <Button
                                    disabled={this.state.buzzFrozen}
                                    color={game.canBuzz ? 'red' : 'grey'}
                                    onClick={() => {
                                      if (game.canBuzz) {
                                        this.submitAnswer(null);
                                      }
                                    }}
                                    icon
                                    labelPosition="left"
                                  >
                                    <Icon
                                      name={game.canBuzz ? 'forward' : 'lock'}
                                    />
                                    Pass
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                            {!game.currentAnswer &&
                            !this.state.localAnswerSubmitted &&
                            game.buzzes[this.props.socket.id] &&
                            game.questionDuration ? (
                              <Input
                                autoFocus
                                label="Answer"
                                value={this.state.localAnswer}
                                onChange={(e) =>
                                  this.setState({ localAnswer: e.target.value })
                                }
                                onKeyPress={(e: any) =>
                                  e.key === 'Enter' && this.submitAnswer()
                                }
                                icon={
                                  <Icon
                                    onClick={() => this.submitAnswer()}
                                    name="arrow right"
                                    inverted
                                    circular
                                    link
                                  />
                                }
                              />
                            ) : null}
                            {game.waitingForWager &&
                            game.waitingForWager[this.props.socket.id] ? (
                              <Input
                                label={`Wager (${
                                  getWagerBounds(
                                    game.round,
                                    game.scores[this.props.socket.id],
                                  ).minWager
                                } to ${
                                  getWagerBounds(
                                    game.round,
                                    game.scores[this.props.socket.id],
                                  ).maxWager
                                })`}
                                value={this.state.localWager}
                                onChange={(e) =>
                                  this.setState({ localWager: e.target.value })
                                }
                                onKeyPress={(e: any) =>
                                  e.key === 'Enter' && this.submitWager()
                                }
                                icon={
                                  <Icon
                                    onClick={() => this.submitWager()}
                                    name="arrow right"
                                    inverted
                                    circular
                                    link
                                  />
                                }
                              />
                            ) : null}
                          </div>
                          <div className={`answer`} style={{ height: '30px' }}>
                            {game.currentAnswer}
                          </div>
                          {Boolean(game.playClueDuration) && (
                            <TimerBar duration={game.playClueDuration} />
                          )}
                          {Boolean(game.questionDuration) && (
                            <TimerBar
                              duration={game.questionDuration}
                              secondary
                              submitAnswer={this.submitAnswer}
                            />
                          )}
                          {Boolean(game.wagerDuration) && (
                            <TimerBar duration={game.wagerDuration} secondary />
                          )}
                          {game.currentAnswer && (
                            <div
                              style={{
                                position: 'absolute',
                                top: '0px',
                                right: '0px',
                              }}
                            >
                              <Button
                                onClick={() =>
                                  this.props.socket.emit('JPD:skipQ')
                                }
                                icon
                                labelPosition="left"
                              >
                                <Icon name="forward" />
                                Next
                              </Button>
                            </div>
                          )}
                          {game.currentAnswer && (
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '0px',
                                right: '0px',
                              }}
                            >
                              <Button
                                onClick={() =>
                                  this.setState({ showJudgingModal: true })
                                }
                                icon
                                labelPosition="left"
                              >
                                <Icon name="gavel" />
                                Bulk Judge
                              </Button>
                            </div>
                          )}
                          {game.currentAnswer && (
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '0px',
                                left: '0px',
                              }}
                            >
                              <Button
                                onClick={() =>
                                  this.props.socket.emit('JPD:undo')
                                }
                                icon
                                labelPosition="left"
                              >
                                <Icon name="undo" />
                                Undo
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {Boolean(game) && game.round === 'end' && (
                      <div id="endgame">
                        <h1 style={{ color: 'white' }}>Winner!</h1>
                        <div style={{ display: 'flex' }}>
                          {this.getWinners().map((winner: string) => (
                            <img
                              key={winner}
                              alt=""
                              style={{ width: '200px', height: '200px' }}
                              src={
                                getDefaultPicture(
                                  this.props.nameMap[winner],
                                  getColorHex(winner),
                                ) || this.props.pictureMap[winner]
                              }
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              }
              <div style={{ height: '8px' }} />
              <div
                style={{ display: 'flex', overflowX: 'auto', flexShrink: 0 }}
              >
                {participants.map((p) => {
                  return (
                    <div key={p.id} className="scoreboard">
                      <div className="picture" style={{ position: 'relative' }}>
                        <img
                          alt=""
                          src={
                            this.props.pictureMap[p.id] ||
                            getDefaultPicture(
                              this.props.nameMap[p.id],
                              getColorHex(p.id),
                            )
                          }
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '4px',
                            left: '0px',
                            width: '100%',
                            backgroundColor: '#' + getColorHex(p.id),
                            color: 'white',
                            borderRadius: '4px',
                            fontSize: '10px',
                            fontWeight: 700,
                            display: 'flex',
                          }}
                        >
                          <div
                            title={this.props.nameMap[p.id] || p.id}
                            style={{
                              width: '100%',
                              backdropFilter: 'brightness(80%)',
                              padding: '4px',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              display: 'inline-block',
                            }}
                          >
                            {this.props.nameMap[p.id] || p.id}
                          </div>
                        </div>
                        {game && p.id in game.wagers ? (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '8px',
                              right: '0px',
                            }}
                          >
                            <Label title="Wager" circular size="tiny">
                              {game.wagers[p.id] || 0}
                            </Label>
                          </div>
                        ) : null}
                        {game && (
                          <div className="icons">
                            {!game.picker || game.picker === p.id ? (
                              <Icon
                                title="Controlling the board"
                                name="pointing up"
                              />
                            ) : null}
                            {game.skips[p.id] ? (
                              <Icon title="Voted to skip" name="forward" />
                            ) : null}
                          </div>
                        )}
                        {game && p.id === game.currentJudgeAnswer ? (
                          <div className="judgeButtons">
                            <Popup
                              content="Correct"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, true)}
                                  color="green"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="check" />
                                </Button>
                              }
                            />
                            <Popup
                              content="Incorrect"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, false)}
                                  color="red"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="close" />
                                </Button>
                              }
                            />
                            <Popup
                              content="Skip"
                              trigger={
                                <Button
                                  onClick={() => this.judgeAnswer(p.id, null)}
                                  color="grey"
                                  size="tiny"
                                  icon
                                  fluid
                                >
                                  <Icon name="angle double right" />
                                </Button>
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={`points ${
                          game?.scores[p.id] < 0 && game?.scoring !== 'coop'
                            ? 'negative'
                            : ''
                        }`}
                      >
                        {game?.scoring === 'coop' &&
                          game?.numCorrect + ' / ' + game?.numTotal}
                        {game?.scoring !== 'coop' &&
                          (game?.scores[p.id] || 0).toLocaleString()}
                      </div>
                      <div
                        className={`answerBox ${
                          game?.buzzes[p.id] ? 'buzz' : ''
                        } ${game?.judges[p.id] === false ? 'negative' : ''}`}
                      >
                        {game && game.answers[p.id]}
                        <div className="timeOffset">
                          {this.getBuzzOffset(p.id) &&
                          this.getBuzzOffset(p.id) > 0
                            ? `+${(this.getBuzzOffset(p.id) / 1000).toFixed(3)}`
                            : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ height: '8px' }} />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  rowGap: '4px',
                }}
              >
                <Dropdown
                  button
                  className="icon"
                  labeled
                  icon="certificate"
                  text="New Game"
                >
                  <Dropdown.Menu>
                    {[
                      { key: 'all', value: null, text: 'Any' },
                      { key: 'kids', value: 'kids', text: 'Kids Week' },
                      { key: 'teen', value: 'teen', text: 'Teen Tournament' },
                      {
                        key: 'college',
                        value: 'college',
                        text: 'College Championship',
                      },
                      {
                        key: 'celebrity',
                        value: 'celebrity',
                        text: 'Celebrity Jeopardy',
                      },
                      {
                        key: 'teacher',
                        value: 'teacher',
                        text: 'Teachers Tournament',
                      },
                      {
                        key: 'champions',
                        value: 'champions',
                        text: 'Tournament of Champions',
                      },
                      {
                        key: 'custom',
                        value: 'custom',
                        text: 'Custom Game',
                      },
                    ].map((item) => (
                      <Dropdown.Item
                        key={item.key}
                        onClick={() => {
                          if (item.value === 'custom') {
                            this.setState({ showCustomModal: true });
                          } else {
                            this.newGame(null, item.value);
                          }
                        }}
                      >
                        {item.text}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
                <Input
                  className="gameSelector"
                  style={{ marginRight: '.25em' }}
                  label="Game #"
                  value={this.state.localEpNum}
                  onChange={(e) =>
                    this.setState({ localEpNum: e.target.value })
                  }
                  onKeyPress={(e: any) =>
                    e.key === 'Enter' &&
                    this.newGame(this.state.localEpNum, null)
                  }
                  icon={
                    <Icon
                      onClick={() => this.newGame(this.state.localEpNum, null)}
                      name="arrow right"
                      inverted
                      circular
                    />
                  }
                />
                {game && game.airDate && (
                  <Label
                    style={{ display: 'flex', alignItems: 'center' }}
                    size="medium"
                  >
                    {new Date(game.airDate + 'T00:00').toLocaleDateString([], {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </Label>
                )}
                <Label
                  style={{ display: 'flex', alignItems: 'center' }}
                  size="medium"
                  color={getColor((game && game.info) || 'standard') as any}
                >
                  {(game && game.info) || 'standard'}
                </Label>
                <Button
                  icon
                  labelPosition="left"
                  color={this.state.readingDisabled ? 'red' : 'green'}
                  onClick={() => {
                    const checked = !this.state.readingDisabled;
                    this.setState({ readingDisabled: checked });
                    if (checked) {
                      window.localStorage.setItem(
                        'jeopardy-readingDisabled',
                        '1',
                      );
                    } else {
                      window.localStorage.removeItem(
                        'jeopardy-readingDisabled',
                      );
                    }
                  }}
                >
                  <Icon name="book" />
                  {this.state.readingDisabled ? 'Reading off' : 'Reading on'}
                </Button>
                <Dropdown
                  button
                  className="icon"
                  labeled
                  icon="calculator"
                  text={
                    scoringOptions.find(
                      (option) => option.value === this.state.game?.scoring,
                    )?.text
                  }
                >
                  <Dropdown.Menu>
                    {scoringOptions.map((item) => (
                      <Dropdown.Item
                        key={item.key}
                        onClick={() => this.changeScoring(item.value)}
                        title={item.title}
                      >
                        {item.text}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
                <Button
                  onClick={() => this.props.socket.emit('JPD:cmdIntro')}
                  icon
                  labelPosition="left"
                  color="blue"
                >
                  <Icon name="film" />
                  Play Intro
                </Button>
              </div>
            </React.Fragment>
          }
          {false && process.env.NODE_ENV === 'development' && (
            <pre
              style={{ color: 'white', height: '200px', overflow: 'scroll' }}
            >
              {JSON.stringify(game, null, 2)}
            </pre>
          )}
        </div>
      </>
    );
  }
}

class TimerBar extends React.Component<{
  duration: number;
  secondary?: boolean;
  submitAnswer?: Function;
}> {
  public state = { width: '0%' };
  submitTimeout: number | null = null;
  componentDidMount() {
    requestAnimationFrame(() => {
      this.setState({ width: '100%' });
    });
    if (this.props.submitAnswer) {
      this.submitTimeout = window.setTimeout(
        this.props.submitAnswer,
        this.props.duration - 500,
      );
    }
  }
  componentWillUnmount() {
    if (this.submitTimeout) {
      window.clearTimeout(this.submitTimeout);
    }
  }
  render() {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: '0px',
          left: '0px',
          height: '10px',
          width: this.state.width,
          backgroundColor: this.props.secondary ? '#16AB39' : '#0E6EB8',
          transition: `${this.props.duration / 1000}s width linear`,
        }}
      />
    );
  }
}

function getWagerBounds(round: string, score: number) {
  // User setting a wager for DD or final
  // Can bet up to current score, minimum of 1000 in single or 2000 in double, 0 in final
  let maxWager = 0;
  let minWager = 5;
  if (round === 'jeopardy') {
    maxWager = Math.max(score || 0, 1000);
  } else if (round === 'double') {
    maxWager = Math.max(score || 0, 2000);
  } else if (round === 'final') {
    minWager = 0;
    maxWager = Math.max(score || 0, 0);
  }
  return { minWager, maxWager };
}

const BulkJudgeModal = ({
  onClose,
  game,
  participants,
  nameMap,
  bulkJudge,
  getBuzzOffset,
}: {
  onClose: () => void;
  game: any;
  participants: User[];
  nameMap: StringDict;
  bulkJudge: (judges: {id: string, correct: boolean | null}[]) => void;
  getBuzzOffset: (id: string) => number;
}) => {
  const [decisions, setDecisions] = useState<StringDict>({});
  const distinctAnswers: string[] = Array.from(
    new Set(
      Object.values<string>(game?.answers ?? {}).map(
        (answer: string) => answer?.toLowerCase()?.trim(),
      ),
    ),
  );
  return (
    <Modal open onClose={onClose}>
      <Modal.Header>{game?.currentAnswer}</Modal.Header>
      <Modal.Content>
        <Table>
          <TableHeader>
            <TableHeaderCell>Answer</TableHeaderCell>
            <TableHeaderCell>Decision</TableHeaderCell>
            <TableHeaderCell>Responses</TableHeaderCell>
          </TableHeader>
          {distinctAnswers.map((answer) => {
            return (
              <TableRow>
                <TableCell>{answer}</TableCell>
                <TableCell>
                  <Dropdown
                    placeholder="Select"
                    value={decisions[answer]}
                    options={[
                      { key: 'correct', value: 'true', text: 'Correct' },
                      { key: 'incorrect', value: 'false', text: 'Incorrect' },
                      { key: 'skip', value: 'skip', text: 'Skip' },
                    ]}
                    onChange={(e, data) => {
                      const newDecisions = {
                        ...decisions,
                        [answer]: data.value as string,
                      };
                      setDecisions(newDecisions);
                    }}
                  ></Dropdown>
                </TableCell>
                <TableCell>
                  {participants
                    .filter(
                      (p) => game?.answers[p.id]?.toLowerCase()?.trim() === answer,
                    )
                    .map((p) => {
                      return (
                        <img
                          style={{ width: '30px' }}
                          alt=""
                          src={getDefaultPicture(
                            nameMap[p.id],
                            getColorHex(p.id),
                          )}
                        />
                      );
                    })}
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
      </Modal.Content>
      <Modal.Actions>
        <Button
          onClick={() => {
            // Submit the judging in order of getBuzzOffset
            const answers = Object.entries<string>(game?.answers);
            const answersInBuzzOrder = [...answers].sort((a, b) => {
              return getBuzzOffset(a[0]) - getBuzzOffset(b[0]);
            });
            // Assemble the bulk judges
            const arr: {id: string, correct: boolean | null}[] = [];
            answersInBuzzOrder.forEach((ans) => {
              // Look up the answer and decision
              const answer = ans[1]?.toLowerCase()?.trim();
              const decision = decisions[answer];
              arr.push({
                id: ans[0],
                correct: decision === 'skip' ? null : JSON.parse(decision),
              });
            });
            bulkJudge(arr);
            // Close the modal
            onClose();
          }}
        >
          Bulk Judge
        </Button>
      </Modal.Actions>
    </Modal>
  );
};
