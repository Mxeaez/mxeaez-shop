export const ITEMS = [
  // ========================= Common (1000) =========================
  { id: "dramatic_zoom", name: "Dramatic Zoom", description: "Dramatically zoom in the webcam for 5 seconds.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/5oc1Sy1.png" },
  { id: "spongebob_stfu", name: "SpongeBob STFU", description: "Play the SpongeBob STFU audio.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/2RAqHrG.png" },
  { id: "titanic_flute", name: "Titanic Flute", description: "Play the Titanic Flute audio.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/kDPfkPc.png" },
  { id: "kc_1000", name: "1000 KC Points", description: "Redeem 1000 KC Points.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/363mGPN.png" },
  { id: "fake_dc", name: "Fake DC", description: "Show the \"Connection Lost\" overlay for 5 seconds.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/03Tb4wv.png" },
  //{ id: "giga_chad", name: "Giga Chad", description: "Giga Chad webcam filter for 5 seconds.", cost: 1000, rarity: "Common", iconUrl: "https://i.imgur.com/nB5ner3.png" },

  // ========================= Rare (5000) =========================
  // { id: "rave_party", name: "Rave", description: "Start a flashing lights rave party.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/jSumMx7.png" },
  { id: "kc_5000", name: "5000 KC Points", description: "Redeem 5000 KC Points.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/AScnziL.png" },
  //{ id: "funky_hat", name: "Funky Hat", description: "Add a random hat overlay to the webcam for 30 seconds.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/ijMRmhI.png" },
  { id: "tts_message", name: "TTS Message", description: "Send a TTS message.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/jt4H56w.png" },
  { id: "voice_changer", name: "Voice Changer", description: "Enable random voice changer for 5 seconds.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/FeIqjaU.png" },
  { id: "camera_flip", name: "Camera Flip", description: "Flip webcam upside down for 5 seconds.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/WUWfTq9.png" },
  { id: "tiny_cam", name: "Tiny Cam", description: "Shrink webcam for 5 seconds.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/nITuUhi.png" },
  //{ id: "streamer_asmr", name: "Streamer ASMR", description: "Turns into ASMR stream for 15 seconds.", cost: 5000, rarity: "Rare", iconUrl: "https://i.imgur.com/WTUEvRv.png" },

  // ========================= Unique (25000) =========================
  { id: "timeout_anyone", name: "Timeout Anyone", description: "Time out anybody in the chat for 5 minutes.", cost: 25000, rarity: "Unique", iconUrl: "https://i.imgur.com/rqdYjzN.png" },
  { id: "kc_25000", name: "25000 KC Points", description: "Redeem 25000 KC points.", cost: 25000, rarity: "Unique", iconUrl: "https://i.imgur.com/ebJ8w4Q.png" },
  //{ id: "notice_me_senpai", name: "Notice Me Senpai", description: "Have your name displayed on stream for 5 minutes.", cost: 25000, rarity: "Unique", iconUrl: "https://i.imgur.com/dWS8drx.png" },
  { id: "mute_streamer", name: "Mute", description: "Force mute mic for 10 seconds.", cost: 25000, rarity: "Unique", iconUrl: "https://i.imgur.com/RchSsRd.png" },
  //{ id: "fullscreen_cam", name: "Full Screen Webcam", description: "Make the face cam full screen for 5 seconds.", cost: 25000, rarity: "Unique", iconUrl: "https://i.imgur.com/F2HEkc0.png" },
  { id: "mystery_box", name: "Mystery Box", description: "Could contain anything! It could even be a mystery box!", cost: 2500, rarity: "Unique", iconUrl: "https://i.imgur.com/N1ES3oc.png" },

  // ========================= Legendary (50000) =========================
  { id: "kc_50000", name: "50000 KC Points", description: "Redeem 50000 KC Points.", cost: 50000, rarity: "Legendary", iconUrl: "https://i.imgur.com/z4w8bxa.png" },
  { id: "vip_badge", name: "VIP", description: "Become a VIP in the chat.", cost: 1000000, rarity: "Legendary", iconUrl: "https://i.imgur.com/zRnirbX.png" },
  { id: "carry_now", name: "Carry Now", description: "You will be the next one to go on a Fang Kit Carry.", cost: 1000000, rarity: "Legendary", iconUrl: "https://i.imgur.com/5QSLc0d.png" },
  { id: "game_master", name: "Game Master", description: "Select an activity I have to do for 30 minutes.", cost: 1000000, rarity: "Legendary", iconUrl: "https://i.imgur.com/cBPQ4vP.png" },
  { id: "equipment_master", name: "Equipment Master", description: "Swap out any single piece of equipment with your choice for a raid.", cost: 1000000, rarity: "Legendary", iconUrl: "https://i.imgur.com/QioD5ut.png" },
] as const;

export const GRANT_ONLY_IDS = [
  "kc_1000",
  "kc_5000",
  "kc_25000",
  "kc_50000",
  "mystery_box", // add this id in ITEMS if you haven't already
];