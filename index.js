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

// Store original prompts and images for regeneration
const messageInputs = {};

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
  if (msg.reply_to_message && bot.me && msg.reply_to_message.from.id === bot.me.id) {
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

// Handle callback queries (for regenerate button)
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;
  const chatId = callbackQuery.message.chat.id;
  
  if (data.startsWith('regenerate_')) {
    // Answer the callback query immediately to prevent timeout
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Regenerating response..." });
    
    // Show typing indicator
    bot.sendChatAction(chatId, 'typing');
    
    // Parse the data to get input info
    const inputId = data.split('_')[1];
    
    if (messageInputs[inputId]) {
      const { prompt, imagePath, conversationId } = messageInputs[inputId];
      
      try {
        // Generate new AI response with the same input
        const { text, imagePaths } = await generateAIResponse(conversationId, prompt, imagePath);
        
        // If the original response was a text message
        if (callbackQuery.message.text) {
          // Edit the original message with new text
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
            }
          });
        } 
        // If the original response was a photo and we have a new photo
        else if (callbackQuery.message.photo && imagePaths.length > 0) {
          // Delete the old message and send a new one
          await bot.deleteMessage(chatId, messageId);
          
          if (text) {
            // Send text response first
            const sentMsg = await bot.sendMessage(chatId, text, {
              reply_markup: {
                inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
              }
            });
            messageToConversation[sentMsg.message_id] = conversationId;
          }
          
          // Send new photo(s)
          for (const imagePath of imagePaths) {
            const sentPhoto = await bot.sendPhoto(chatId, fs.createReadStream(imagePath), {
              reply_markup: {
                inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
              }
            });
            messageToConversation[sentPhoto.message_id] = conversationId;
            fs.unlinkSync(imagePath);
          }
        }
        // If the original was a photo but we only have text now
        else if (callbackQuery.message.photo && imagePaths.length === 0 && text) {
          // Delete the old message and send a new one
          await bot.deleteMessage(chatId, messageId);
          const sentMsg = await bot.sendMessage(chatId, text, {
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
            }
          });
          messageToConversation[sentMsg.message_id] = conversationId;
        }
      } catch (error) {
        console.error('Error regenerating response:', error);
        // Since we already answered the callback query, we'll send an error message
        bot.sendMessage(chatId, "Sorry, I couldn't regenerate the response.", {
          reply_to_message_id: messageId
        });
      }
    } else {
      // We've already answered the callback query above, so no need to do it again
      bot.sendMessage(chatId, "Cannot regenerate this response. The original message is no longer available.");
    }
  }
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
    
    // Use message ID for regeneration
    const inputId = msg.message_id.toString();
    
    // Store the input for potential regeneration
    messageInputs[inputId] = {
      prompt: caption,
      imagePath: filePath,
      conversationId
    };
    
    // Generate AI response with image
    const { text, imagePaths, conversationId: resultConvId } = await generateAIResponse(conversationId, caption, filePath);
    
    // Send the text response
    if (text) {
      const sentMsg = await bot.sendMessage(chatId, text, { 
        reply_to_message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
        }
      });
      // Store this message ID with its conversation
      messageToConversation[sentMsg.message_id] = resultConvId;
    }
    
    // Send any images that were generated
    for (const imagePath of imagePaths) {
      const sentPhoto = await bot.sendPhoto(chatId, fs.createReadStream(imagePath), { 
        reply_to_message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
        }
      });
      // Store this message ID with its conversation
      messageToConversation[sentPhoto.message_id] = resultConvId;
      // Clean up the response image after sending
      fs.unlinkSync(imagePath);
    }
    
    // Don't delete the uploaded file yet since we might need it for regeneration
    // We'll clean it up when we no longer need it (e.g., after some time)
  } catch (error) {
    console.error('Error processing photo:', error);
    bot.sendMessage(chatId, "Sorry, I couldn't process that image.", { reply_to_message_id: msg.message_id });
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
      // Use message ID for regeneration
      const inputId = msg.message_id.toString();
      
      // Store the input for potential regeneration
      messageInputs[inputId] = {
        prompt: msg.text,
        imagePath: null,
        conversationId
      };
      
      // Generate AI response
      const { text, imagePaths, conversationId: resultConvId } = await generateAIResponse(conversationId, msg.text);
      
      // Send the text response
      if (text) {
        const sentMsg = await bot.sendMessage(chatId, text, { 
          reply_to_message_id: msg.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
          }
        });
        // Store this message ID with its conversation
        messageToConversation[sentMsg.message_id] = resultConvId;
      }
      
      // Send any images that were generated
      for (const imagePath of imagePaths) {
        const sentPhoto = await bot.sendPhoto(chatId, fs.createReadStream(imagePath), { 
          reply_to_message_id: msg.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Regenerate', callback_data: `regenerate_${inputId}` }]]
          }
        });
        // Store this message ID with its conversation
        messageToConversation[sentPhoto.message_id] = resultConvId;
        // Clean up the response image after sending
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      bot.sendMessage(chatId, "Sorry, I couldn't process your message.", { reply_to_message_id: msg.message_id });
    }
  }
});

// Clean up old stored inputs and images periodically (every hour)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  // Clean up old messageInputs entries
  // Now we need to use a different method since we're using message IDs instead of timestamps
  // We'll check the creation time of the image files instead
  Object.keys(messageInputs).forEach(inputId => {
    const entry = messageInputs[inputId];
    if (entry.imagePath && fs.existsSync(entry.imagePath)) {
      try {
        const stats = fs.statSync(entry.imagePath);
        // If the file is older than an hour
        if (stats.birthtimeMs < oneHourAgo) {
          fs.unlinkSync(entry.imagePath);
          delete messageInputs[inputId];
        }
      } catch (err) {
        console.error('Error checking/deleting old file:', err);
        // If there's an error, still try to delete the entry
        delete messageInputs[inputId];
      }
    } else if (!entry.imagePath) {
      // For text-only entries, keep them for a day (since they don't use disk space)
      // This logic can be adjusted as needed
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      if (parseInt(entry.conversationId.split('_')[1]) < oneDayAgo) {
        delete messageInputs[inputId];
      }
    }
  });
}, 60 * 60 * 1000); // Run every hour

console.log('Bot is running with full AI integration using experimental model and conversation threading...'); 