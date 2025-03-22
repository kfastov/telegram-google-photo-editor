# Google Photo Editor Telegram Bot

A Telegram bot powered by Google's Gemini 2.0 Flash Experimental AI model that processes both text and images.

## Features

- Natural language AI chat assistant
- Advanced image capabilities:
  - Analyze and understand image content
  - Edit and transform existing photos
  - Generate new images based on your uploaded ones
- Smart conversation management:
  - New messages start fresh conversations
  - Replies to bot messages maintain context

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get your token
2. Get a Gemini API key from [Google AI Studio](https://ai.google.dev/)
3. Create a `.env` file with:
   ```
   BOT_TOKEN=your_telegram_bot_token_here
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
4. Install dependencies: `npm install`
5. Start the bot: `npm start`

## Commands

- `/reset` - Clear your chat history and start fresh

## Usage Tips

- Send new messages for new conversations
- Reply to bot messages to continue with context
- Try image prompts like:
  - "What's in this photo?"
  - "Transform this into a watercolor painting"
  - "Edit this photo to have a mountain background"
  - "Create a variation of this image in anime style"

---

_This project was vibecoded with Cursor using Claude 3.7 Sonnet_

## Dependencies

- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) - Telegram Bot API for Node.js
- [dotenv](https://github.com/motdotla/dotenv) - For loading environment variables
- [@google/generative-ai](https://www.npmjs.com/package/@google/generative-ai) - Google's Generative AI SDK
