# AI-Enhanced Jeopardy

An interactive web-based Jeopardy! game that uses OpenAI's GPT-4 and TTS for enhanced gameplay. Forked from [howardchung/jeopardy](https://github.com/howardchung/jeopardy)..

## Jeopardy Data Information (Please Read)

Game data was found freely available online and was not obtained through web scraping or automated collection methods. I respect intellectual property rights and will promptly remove any content upon request from rights holders.

## Features

### AI Integration
- **Automated Answer Judging**: Uses GPT-4 to intelligently assess answer correctness considering variations, spellings, and partial matches
- **Text-to-Speech**: OpenAI's TTS reads categories and clues in a natural voice
- **Interactive Host**: AI responds with dynamic phrases for correct/incorrect answers

### Docker / Docker Compose
- **Docker Composeable**: Includes dockerfiles for separate frontend/backend servers using Nginx and a docker-compose file for running it all with one click.

### Game Mechanics
- Complete implementation of Jeopardy!, Double Jeopardy!, and Final Jeopardy! rounds
- Support for Daily Doubles with wagering
- Multiple scoring modes: Standard, Coryat, and Co-op
- Real-time buzzer system with precise timing
- Multi-room support for simultaneous private games

### Multiplayer Features
- Real-time synchronization
- Built-in text chat
- Buzzer timing and order tracking
- Score tracking and leaderboards

## Technical Details

### Prerequisites
- Node.js
- Redis (optional, for persistence)
- OpenAI API key

### Environment Variables
```
OPENAI_API_KEY=your_api_key_here
REDIS_URL=your_redis_url (optional)
```

### Installation
```bash
git clone https://github.com/[your-username]/ai-enhanced-jeopardy
cd ai-enhanced-jeopardy
npm install
npm run build
npm start
```

### Data Sources
- Game content can be obtained from [J-Archive](http://j-archive.com/) but the author advises against this as J-Archive does not allow scraping. Please obtain game content legally.
- Custom games via CSV import

### Technology Stack
- React (Frontend)
- TypeScript
- Node.js (Backend)
- Socket.IO (Real-time communication)
- Redis (Optional persistence)
- OpenAI API (GPT-4 & TTS)

## Custom Game Creation
Create your own games using a CSV file with the following format:
```csv
round,cat,q,a,dd
jeopardy,Science,This force keeps planets in orbit,Gravity,false
```

## Credits
- Original project by Howard Chung
- Enhanced with AI capabilities by Frederic Rohrer

## License
MIT License - See LICENSE file for details