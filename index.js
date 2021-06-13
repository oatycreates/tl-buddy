'use strict';

/**
 * TLBuddy
 *
 * Provides notifications on Discord for translation messages posted during YouTube livestreams.
 * Offers customisable prefixes to match the translation style and language.
 *
 * Add this bot to your Discord server:
 * https://discord.com/oauth2/authorize?client_id=853320365514031155&scope=bot+applications.commands
 *
 * To run the bot locally (needs Node/npm installed): npm install && node .
 *
 * To deploy to Google App Engine (once configured): gcloud app deploy
 *
 * If you find this bot useful, please consider supporting at:
 * https://ko-fi.com/oatycreates
 *
 * Author: Oats - @OatyCreates ©2021
 */

// Set up environment variables
// See: https://github.com/motdotla/dotenv
import dotenv from 'dotenv';
dotenv.config();
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const DISCORD_API_KEY = process.env.DISCORD_API_KEY;

import express from 'express';
// See: https://developers.google.com/youtube/v3/docs
import { google, youtube_v3 } from 'googleapis';
// import 'google-auth-library'; // May not be needed
// See: https://discord.com/developers/docs/reference
import Discord from 'discord.js';
// See: https://medialize.github.io/URI.js/
import URI from 'uri.js';
// See: https://lodash.com/
import _ from 'lodash';

const expressApp = express();
const youtube = google.youtube({
  version: 'v3',
  auth: YOUTUBE_API_KEY,
});
const discordClient = new Discord.Client();

// Discord messages must start with these commands to be recognised
const SUBSCRIBE_COMMAND = '!tlwatch';
const UNSUBSCRIBE_COMMAND = '!tlstop';
const PREFIX_ADD_COMMAND = '!tlprefix';

const DEFAULT_CHAT_PREFIXES = ['[EN]', 'EN:']; // Use until specific ones are provided
// Maximum number of messages to get per paged request between [200,2000] default 500
const MAX_LIVE_MESSAGES_PAGE = 500;
// Lowest live chat poll time allowed, will go higher if YouTube API requests it
// 30 seconds wait should allow approx 83 continuously run videos in a day
// realistically most videos should be shorter than that and not continuously
// tracked so this should provide ample video tracking before hitting YT API limts.
const DEFAULT_LIVE_CHAT_POLL_TIME = 30000;// 5000;
// How many translation messages to batch together to reduce API usage.
const DISCORD_TL_MESSAGE_BATCH_MAX = 5;

let beenInitialised = false;
let trackedVids = [/*
  [videoId]: {
    liveChatId: '#######',
    nextPageToken: string, // Next YouTube live chat pagination page ID
    pollTime: number, // Wait in ms between live chat polls, set to -1 to stop polling
    subscribers: [
      {
        discordChannelId: '#######', // Use this to prevent double subscribing instead of user ID
        discordChannel: [DiscordChannel], // For ease of use posting messages
        chatPrefixes: [ // Case sensitive
          '[EN]'
          'EN:'
        ],
        postedMessages: [
          discordMessageId: '######',
          youtubeMessageId: '######',
        ]
      }
    ]
  }
*/];

// Start a basic server so the hosting platform knows the script is active
expressApp.get('/', (req, res) => {
  // Just report OK for now
  res.status(200).send().end();
});

// Start the server, Discord/YT communication is handled by their libraries
const PORT = process.env.PORT || 8080;
expressApp.listen(PORT, () => {
  if (!beenInitialised) {
    init();
  }

  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

async function init() {
  if (beenInitialised) {
    console.error('Already initialised!');
    return;
  }

  // Prepare API clients
  await loginDiscord()
    .then(registerDiscordListeners)
    .then(function () {
        console.log('API clients initialised!');
        beenInitialised = true;
      },
      function (err) { console.error('Error preparing API clients', err); });
}

function loginDiscord() {
  return discordClient.login(DISCORD_API_KEY)
    .then(function () { console.log('Discord API client loaded'); },
      function (err) { console.error('Error loading Discord client', err); });
}

function registerDiscordListeners() {
  discordClient.on(Discord.Constants.Events.MESSAGE_CREATE, handleDiscordMsg);
}

/**
 * Processes input Discord messages and checks if they match a registered command.
 * @param {Discord.Message} message Message data from Discord.
 */
function handleDiscordMsg(message) {
  if (message.content.startsWith(SUBSCRIBE_COMMAND)) {
    // Attempt to subscribe to messages from input video (first argument)
    let videoId = extractVideoId(message.content);
    if (!_.isEmpty(videoId)) {
      // Attempt to subscribe the live chat for that video
      let discordChannelId = message.channel.id;
      registerVideoSubscriber(videoId, discordChannelId, message.channel);
    } else {
      // Notify user that the video ID couldn't be found and a standard YouTube link is needed.
      sendDiscordMessage(message.channel, `Couldn\'t find that video ID!\nFormat: \`${SUBSCRIBE_COMMAND} https://www.youtube.com/watch?v=###########\``);
      console.warn('Empty video ID!');
    }
  } else if (message.content.startsWith(UNSUBSCRIBE_COMMAND)) {
    // Unsubscribe from all videos on the current channel
    _.forIn(trackedVids, vid => {
      _.remove(vid.subscribers, (sub) => {
        return _.isEqual(sub.discordChannelId, message.channel.id);
      })
    });

    console.log(`No longer listening for translations for channel ${message.channel.id}`);
    sendDiscordMessage(message.channel, 'No longer listening for translations.');
  } else if (message.content.startsWith(PREFIX_ADD_COMMAND)) {
    // Replace new prefixes to search for in translation messages
    let msgParts = message.content.split(' ');
    if (msgParts.length >= 2 && msgParts[1].length > 0) {
      let listeningPrefixes = _.slice(msgParts, 1);
      _.forIn(trackedVids, vid => {
        _.forEach(vid.subscribers, (sub) => {
          if (sub.discordChannelId === message.channel.id) {
            // Replace existing chat prefixes with the new ones
            sub.chatPrefixes = [];
            for (let i = 1; i < msgParts.length; ++i) {
              let translationPrefix = msgParts[i];
              sub.chatPrefixes.push(translationPrefix);
            }
          }
        })
      });
      let prefixMsg = `Now also listening for translation prefixes: \`${listeningPrefixes.join(' ')}\``;
      console.log(prefixMsg + ` in channel ${message.channel.id}`);
      sendDiscordMessage(message.channel, prefixMsg);
    } else {
      sendDiscordMessage(message.channel, `Couldn\'t add translation prefix!\nFormat (space-separated): \`${PREFIX_ADD_COMMAND} [ES] ES:\``);
      console.warn(`Couldn\'t add translation prefix!`);
    }
  }
}

/**
 * Attempts to extract the video ID from an incoming Discord command message.
 * @param {String} msgData Discord message data to parse.
 * @returns Extracted video ID or null.
 */
function extractVideoId(msgData) {
  let msgParts = msgData.split(' ');
  let videoId = null;
  if (msgParts.length >= 2 && msgParts[1].length > 0) {
    let videoUrl = new URI(msgParts[1]);
    if (!_.isEmpty(videoUrl.query) && !_.isEmpty(videoUrl.query.v)) {
      videoId = videoUrl.query.v;
    } else {
      console.warn('Invalid video URL format!');
    }
  } else {
    console.warn('Invalid subscribe command format!');
  }

  return videoId;
}

/**
 * Registers for YouTube live chat notifications and registers subscriber data.
 * @param {String} videoId YouTube video ID to use.
 * @param {String} discordChannelId Discord channel ID that wants notifications.
 * @param {Discord.TextChannel | Discord.DMChannel | Discord.NewsChannel} discordChannel Discord channel that wants notifications.
 * @returns YouTube live chat ID, or null.
 */
async function registerVideoSubscriber(videoId, discordChannelId, discordChannel) {
  if (_.isEmpty(trackedVids[videoId])) {
    // This is a new video, register for polling
    let liveChatId = await fetchChatId(videoId);
    if (_.isEmpty(liveChatId)) {
      console.log(`Couldn't find a live chat for video \`${videoId}\`.`);
      sendDiscordMessage(discordChannel, `Couldn't find a live chat for video \`${videoId}\`, is it a livestream?\nOr an internal error may have occurred.`);
      return null;
    }

    trackedVids[videoId] = {
      liveChatId,
      pollTime: DEFAULT_LIVE_CHAT_POLL_TIME,
      subscribers: []
    }
    pollMessages_R(videoId);
  }

  let hasExistingSub = _.findIndex(trackedVids[videoId].subscribers, (sub) => {
    sub.discordChannelId === discordChannelId;
  }) !== -1;
  if (!hasExistingSub) {
    trackedVids[videoId].subscribers.push({
      discordChannelId, // Use this to prevent double subscribing instead of user ID
      discordChannel, // For ease of use posting messages
      chatPrefixes: [], // Will fall back to default until a prefix is provided
      postedMessages: [],
    });
  }

  // Notify the Discord channel that the bot's now listening for translations
  //   mention how to stop the translations, and how to set more prefixes.
  console.log(`Listening for translations for video \`${videoId}\`.`);
  sendDiscordMessage(discordChannel, `Listening for translations for video \`${videoId}\`.` +
    `\nStop with \`${UNSUBSCRIBE_COMMAND}\` and set prefixes to listen for with \`${PREFIX_ADD_COMMAND}\`` +
    ` (Defaults to: \`${DEFAULT_CHAT_PREFIXES.join(' ')}\`)`);

  return trackedVids[videoId].liveChatId;
}

/**
 * Polls for YouTube live chat messages at the requested interval until stopped
 * (the last subscriber for a video unsubscribes or the video ends).
 * @param {String} videoId YouTube video ID to use.
 */
async function pollMessages_R(videoId) {
  let messageData = await fetchMessages(trackedVids[videoId].liveChatId, '');

  if (trackedVids[videoId].pollTime <= 0) {
    return;
  }

  let { messages, nextPageToken, offlineAt, pollingIntervalMillis } = messageData;
  if (_.isEmpty(offlineAt)) {
    let stopFromAPIError = false;
    if (_.isEmpty(messageData.error)) {
      trackedVids[videoId].nextPageToken = nextPageToken;
      // Don't ever poll faster than the default to avoid hitting API quota limits
      trackedVids[videoId].pollTime = pollingIntervalMillis > DEFAULT_LIVE_CHAT_POLL_TIME ? pollingIntervalMillis : DEFAULT_LIVE_CHAT_POLL_TIME;

      // Process messages, ignores duplicates
      processYTChatMessages(videoId, messages);
    } else {
      // There was an API error, work out whether we need to stop listening
      if (_.findIndex(messageData.error.errors, (err) => _.isEqual(err.reason, 'quotaExceeded')) !== -1) {
        stopFromAPIError = true;
      }
    }

    // Schedule the next message check if valid
    if (!stopFromAPIError && trackedVids[videoId].pollTime > 0) {
      setTimeout(() => pollMessages_R(videoId), trackedVids[videoId].pollTime);
    } else if (stopFromAPIError) {
      console.log(`Stopped listening for livestream: \`${videoId}\`, due to YT API response error.`);
      _.forEach(trackedVids[videoId].subscribers, (sub) => {
        sendDiscordMessage(sub.discordChannel, `Stopped listening for livestream: \`${videoId}\`, an internal error occurred.`);
      });

      delete trackedVids[videoId];
    }
  } else {
    // Stream is now offline, remove from subscriptions and notify listening chats
    console.log(`Livestream \`${videoId}\` has ended, stopping listening.`);
    _.forEach(trackedVids[videoId].subscribers, (sub) => {
      sendDiscordMessage(sub.discordChannel, `Livestream has ended for \`${videoId}\`, stopping listening.`);
    });

    delete trackedVids[videoId];
  }
}

/**
 * Processes youtube live chat messages, avoiding messages previously handled.
 * @param {String} videoId YouTube video ID to use.
 * @param {youtube_v3.Schema$LiveChatMessage[]} messages Data of the incoming YT live chat messages.
 */
function processYTChatMessages(videoId, messages) {
  // Notify all subscribers that haven't heard about this already
  trackedVids[videoId].subscribers.forEach(sub => {
    let chatPrefixes = DEFAULT_CHAT_PREFIXES;
    if (sub.chatPrefixes.length > 0) {
      // Use the supplied chat prefixes instead
      chatPrefixes = sub.chatPrefixes;
    }

    // Batch messages and send as chunks to avoid hitting Discord API limits
    let batchedMessages = prepareBatchTLMessages(messages, chatPrefixes);
    if (batchedMessages.length === 0) {
      // There weren't any valid translation messages in the batch
      return;
    }

    batchedMessages.forEach(async batchedMsg => {
      let postedMsgIndex = _.findIndex(sub.postedMessages, (msg) => {
        return _.findIndex(batchedMessages.postIds, (postId) => msg.youtubeMessageId === postId) !== -1;
      });
      if (postedMsgIndex === -1) {
        // Share this message to Discord
        let sentMsg = await sendDiscordMessage(sub.discordChannel, batchedMsg.message);

        sub.postedMessages.push({
          discordMessageId: sentMsg.id,
          youtubeMessageId: id,
        });
      }
    })
  });
}

/**
 * Groups together the display-friendly translation messages for sending in discord.
 * @param {youtube_v3.Schema$LiveChatMessage[]} messages Data of the incoming YT live chat messages.
 * @param {String[]} chatPrefixes Chat prefixes to filter messages by.
 * @returns Combined messages ready for sending to Discord and IDs list.
 *   Batched messages split by newlines.
 */
function prepareBatchTLMessages(messages, chatPrefixes) {
  let batchedMessages = [/**{
    message: String
    postIds: String[]
  }*/];
  let currMessages = [];
  let currPostIds = [];
  messages.forEach(message => {
    let { id, authorDetails, snippet } = message;
    let messageText = snippet.displayMessage;

    let matchingChatPrefix = _.findIndex(chatPrefixes, (prefix) => (
      messageText.includes(prefix)
    )) !== -1;

    if (matchingChatPrefix) {
      let repeatMsg = `> **${authorDetails.displayName}** - ${messageText}`;
      if (currPostIds.length < DISCORD_TL_MESSAGE_BATCH_MAX) {
        currMessages.push(repeatMsg);
        currPostIds.push(id);
      } else {
        // Wrap up current batch and start a new one
        batchedMessages.push({
          message: currMessages.join('\n'),
          postIds: currPostIds,
        });
        currMessages = [];
        currPostIds = [];
      }
    }
  });

  // If there's a remaining incomplete batch, prepare it as-is
  if (currPostIds.length > 0) {
    batchedMessages.push({
      message: currMessages.join('\n'),
      postIds: currPostIds,
    });
  }

  return batchedMessages;
}

/**
 * Handles sending a Discord message to the input channel
 * @param {Discord.TextChannel | Discord.DMChannel | Discord.NewsChannel} discordChannel Discord channel to send the message to.
 * @param {Discord.APIMessageContentResolvable} message Message data to send, can also just be a string
 * @returns Promise resolves to: Sent message data.
 */
function sendDiscordMessage(discordChannel, message) {
  return discordChannel.send(message);
}

/**
 * Fetches the livestream chat ID for a given YouTube video.
 * @param {String} videoId YouTube video ID to process.
 * @returns Promise resolving to: Livestream chat ID, or null.
 */
function fetchChatId(videoId) {
  return youtube.videos.list({
    part: ['liveStreamingDetails'],
    id: [videoId]
  })
    .then(function (response) {
      // Pull live chat ID from video livestream data
      let responseData = response.data;
      let liveChatId = null;
      if (responseData.items.length > 0) {
        liveChatId = responseData.items[0].liveStreamingDetails.activeLiveChatId;
      } else {
        // No matching livestream chat was found livestream may have ended or
        // it's a video that doesn't have a live chat
        console.warn('No matching livestream chat was found for video ID', videoId);
      }

      return liveChatId;
    },
      function (err) {
        console.error('Execute error - fetchChatId', err);
        return null;
      });
}

/**
 * Fetches the latest page of messages from the chat.
 * @param {String} liveChatId ID of the Live chat to retrieve messages from.
 * @param {String} pageToken Optional - Pagination token received from a previous response.
 * @returns Promise that resolves to retrieved messages, or empty array if failed to retrieve
 */
function fetchMessages(liveChatId, pageToken) {
  return youtube.liveChatMessages.list({
    liveChatId,
    part: [
      'id',
      'snippet',
      'authorDetails',
    ],
    maxResults: MAX_LIVE_MESSAGES_PAGE,
    pageToken: pageToken,
  })
    .then(function (response) {
      // Pull message data and information for following requests
      let responseData = response.data;
      return {
        messages: responseData.items,
        nextPageToken: responseData.nextPageToken,
        offlineAt: responseData.offlineAt,
        pollingIntervalMillis: responseData.pollingIntervalMillis,
      }
    },
      function (err) {
        console.error('Execute error - fetchMessages', err);
        return {
          messages: [],
          error: err,
        };
      });
}
