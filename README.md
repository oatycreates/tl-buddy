# TLBuddy

Provides notifications in Discord for translation messages posted during YouTube livestreams.
Offers customisable prefixes to match the translation style and language.

**Add this bot to your Discord server:**
https://discord.com/oauth2/authorize?client_id=853320365514031155&scope=bot+applications.commands

If you find this bot useful, please consider supporting at:
[ko-fi.com/oatycreates](https://ko-fi.com/oatycreates)

Thanks as always to the translators ❤

Author: Oats - [@OatyCreates](https://twitter.com/oatycreates) ©2021

## Running

Ensure you set up a **.env** file in this folder and set:

* `YOUTUBE_API_KEY` (from [Google Cloud Platform - YouTube APIs](https://console.cloud.google.com/apis/library/youtube.googleapis.com))
* `DISCORD_API_KEY` (from [Discord Developer Portal - Bot Token](https://discord.com/developers/applications))

To run the bot locally (needs Node/npm installed): `npm install && node .`

To deploy to Google App Engine (once configured): `gcloud app deploy`

## Command examples

* `!tlwatch https://www.youtube.com/watch?v=###########`
* `!tlstop`
* `!tlprefix [ES] ES:`
