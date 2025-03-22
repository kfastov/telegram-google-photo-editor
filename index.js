// Import dependencies
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// Create a map to store active conversation contexts
const userContexts = {};

// Get the bot token from environment variables
const token = process.env.BOT_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.0-flash-exp",
  generationConfig: {
    responseModalities: ["Text", "Image"],
  },
});

// Create a new bot instance
const bot = new TelegramBot(token, { polling: true });

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Store chat history for each user
const chatHistory = {};

// Store message IDs to their conversations
const messageToConversation = {};

// Function to download file from Telegram
async function downloadFile(fileId) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const filePath = path.join(uploadsDir, `${fileId}.jpg`);
    
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
    });
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    throw error;
  }
}

// Function to read image as base64
function fileToGenerativePart(filePath) {
  const fileData = fs.readFileSync(filePath);
  return {
    inlineData: {
      data: fileData.toString('base64'),
      mimeType: 'image/jpeg',
    },
  };
}

// Function to generate a unique conversation ID
function generateConversationId(userId) {
  return `${userId}_${Date.now()}`;
}

// Function to determine if this is a new conversation or continuing one
function getConversationId(msg) {
  const userId = msg.from.id;
  
  // Check if this is a reply to a previous message
  if (msg.reply_to_message && msg.reply_to_message.from.id === bot.me.id) {
    const repliedMsgId = msg.reply_to_message.message_id;
    // If we have this message ID mapped to a conversation, use that conversation
    if (messageToConversation[repliedMsgId]) {
      return messageToConversation[repliedMsgId];
    }
  }
  
  // Otherwise, create a new conversation ID
  const conversationId = generateConversationId(userId);
  
  // Initialize an empty history for this new conversation
  if (!chatHistory[conversationId]) {
    chatHistory[conversationId] = [];
  }
  
  return conversationId;
}

// Function to generate AI response
async function generateAIResponse(conversationId, prompt, imagePath = null) {
  try {
    // Initialize chat history for this conversation if it doesn't exist
    if (!chatHistory[conversationId]) {
      chatHistory[conversationId] = [];
    }

    // Get the chat history for this conversation (limited to the last 10 messages)
    const history = chatHistory[conversationId].slice(-10);
    
    // Prepare parts based on whether there's an image or not
    let parts = [];
    if (imagePath) {
      parts = [
        { text: prompt },
        fileToGenerativePart(imagePath)
      ];
    } else {
      parts = [{ text: prompt }];
    }
    
    // Create a request with history
    const messages = [
      ...history.map(msg => ({
        role: msg.role,
        parts: msg.parts
      })),
      { role: "user", parts: parts }
    ];
    
    // Generate content with history
    const result = await model.generateContent({
      contents: messages,
      generationConfig: {
        responseModalities: ["Text", "Image"],
      },
    });
    
    const response = result.response;
    const text = response.text();
    
    // Check if there are any images in the response
    let imagePaths = [];
    
    if (response.candidates && response.candidates[0] && response.candidates[0].content.parts) {
      const responseParts = response.candidates[0].content.parts;
      
      for (const part of responseParts) {
        if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
          // Save image to file
          const imageData = part.inlineData.data;
          const buffer = Buffer.from(imageData, 'base64');
          const responsePath = path.join(uploadsDir, `response_${Date.now()}_${imagePaths.length}.jpg`);
          fs.writeFileSync(responsePath, buffer);
          imagePaths.push(responsePath);
        }
      }
    }
    
    // Add user message and AI response to history
    history.push({ role: "user", parts: parts });
    history.push({ role: "model", parts: [{ text: text }] });
    
    // Update history and limit size
    chatHistory[conversationId] = history;
    if (chatHistory[conversationId].length > 20) {
      chatHistory[conversationId] = chatHistory[conversationId].slice(-20);
    }
    
    return { text, imagePaths, conversationId };
  } catch (error) {
    console.error('Error generating AI response:', error);
    return { text: "Sorry, I couldn't process that request.", imagePaths: [], conversationId };
  }
}

// Store bot information when the bot starts
bot.getMe().then(me => {
  bot.me = me;
}).catch(error => {
  console.error('Error getting bot info:', error);
});

// Listen for /reset command to clear chat history
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Clear all chat history for this user
  Object.keys(chatHistory).forEach(convId => {
    if (convId.startsWith(`${userId}_`)) {
      delete chatHistory[convId];
    }
  });
  
  bot.sendMessage(chatId, "Chat history has been reset. We're starting a fresh conversation!");
});

// Listen for photo uploads
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  
  // Get the conversation ID (either existing or new)
  const conversationId = getConversationId(msg);
  
  // Get the highest resolution photo
  const photoId = msg.photo[msg.photo.length - 1].file_id;
  
  // Get the caption if provided
  const caption = msg.caption || "What's in this image?";
  
  // Show typing indicator
  bot.sendChatAction(chatId, 'typing');
  
  try {
    // Download the photo
    const filePath = await downloadFile(photoId);
    
    // Generate AI response with image
    const { text, imagePaths, conversationId: resultConvId } = await generateAIResponse(conversationId, caption, filePath);
    
    // Send the text response
    if (text) {
      const sentMsg = await bot.sendMessage(chatId, text);
      // Store this message ID with its conversation
      messageToConversation[sentMsg.message_id] = resultConvId;
    }
    
    // Send any images that were generated
    for (const imagePath of imagePaths) {
      const sentPhoto = await bot.sendPhoto(chatId, fs.createReadStream(imagePath));
      // Store this message ID with its conversation
      messageToConversation[sentPhoto.message_id] = resultConvId;
      // Clean up the response image after sending
      fs.unlinkSync(imagePath);
    }
    
    // Clean up - delete the uploaded file after processing
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error processing photo:', error);
    bot.sendMessage(chatId, "Sorry, I couldn't process that image.");
  }
});

// Process all non-command messages with AI
bot.on('message', async (msg) => {
  // Skip processing if it's a command or a photo (already handled separately)
  if (msg.text && msg.text.startsWith('/')) return;
  if (msg.photo) return;
  
  const chatId = msg.chat.id;
  
  // Log the message to console
  if (msg.text) {
    console.log(`Received message: ${msg.text} from ${msg.from.first_name}`);
    
    // Get the conversation ID (either existing or new)
    const conversationId = getConversationId(msg);
    
    // Show typing indicator
    bot.sendChatAction(chatId, 'typing');
    
    try {
      // Generate AI response
      const { text, imagePaths, conversationId: resultConvId } = await generateAIResponse(conversationId, msg.text);
      
      // Send the text response
      if (text) {
        const sentMsg = await bot.sendMessage(chatId, text);
        // Store this message ID with its conversation
        messageToConversation[sentMsg.message_id] = resultConvId;
      }
      
      // Send any images that were generated
      for (const imagePath of imagePaths) {
        const sentPhoto = await bot.sendPhoto(chatId, fs.createReadStream(imagePath));
        // Store this message ID with its conversation
        messageToConversation[sentPhoto.message_id] = resultConvId;
        // Clean up the response image after sending
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      bot.sendMessage(chatId, "Sorry, I couldn't process your message.");
    }
  }
});

console.log('Bot is running with full AI integration using experimental model and conversation threading...'); 