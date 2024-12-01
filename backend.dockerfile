# backend.dockerfile
# Stage 1: Download and parse J-Archive data
FROM python:3.10 as jarchive-builder

WORKDIR /jarchive

COPY ./jeoPARTY ./

# Install python dependencies and run parser
RUN pip install -r requirements.txt
RUN python parse.py

# Stage 2: Parse CSV to JSON
FROM node:18-alpine as json-builder

WORKDIR /parser

# Copy CSV from previous stage
COPY --from=jarchive-builder /jarchive/jeopardy.csv ./

# Copy parser script and dependencies
COPY ./server/parseJArchiveCsv.js ./
COPY package*.json ./

RUN npm install
RUN node parseJArchiveCsv.js

# Stage 3: Build and run the actual server
FROM node:18-alpine

WORKDIR /app

# Copy package files and TypeScript configs
COPY package*.json ./
COPY tsconfig.json ./
COPY global.d.ts ./
COPY server/tsconfig.json ./server/

# Install dependencies
RUN npm install

# Copy source code
COPY server/ ./server/
COPY words/ ./words

# Copy the parsed jeopardy data from previous stage
COPY --from=json-builder /parser/jeopardy.json ./

# Build the server
RUN npm run buildServer

EXPOSE 3000
ENV PORT=3000

CMD ["npm", "run", "server"]
# CMD ["tail", "-f", "/dev/null"]