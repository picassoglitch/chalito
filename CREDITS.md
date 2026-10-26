# Credits

## From Alux, by Omar (homiomar)

Omar let Chalito use ideas and code from his desktop companion Alux. Thank you, Omar.

- PR status alerts: each approval, change request, review comment, CI result and merge on your own GitHub PRs is told once and tied to the session on that branch ([pet/prs.js](https://github.com/homiomar/sacbe/blob/main/pet/prs.js), [pet/main.js](https://github.com/homiomar/sacbe/blob/main/pet/main.js)).
- Offline voice commands: the end-of-speech detector that learns the room's noise floor ([vad.js](https://github.com/homiomar/sacbe/blob/main/pet/vad.js)), decoding once per language and keeping the most confident result, plus the WAV writer ([whisper.js](https://github.com/homiomar/sacbe/blob/main/pet/whisper.js)), rules-only intent parsing ([intent.js](https://github.com/homiomar/sacbe/blob/main/pet/intent.js)) and the "this, this or both?" card that runs nothing until it's clicked ([main.js](https://github.com/homiomar/sacbe/blob/main/pet/main.js)).
