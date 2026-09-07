const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/process', (req, res) => {
  const text = req.body.text || "";
  console.log("Received:", text);

  // Simulate a 2-second processing delay so we have time to test interruption
  setTimeout(() => {
    res.json({
      action: "search",
      content: text,
      spoken_response: "This is a test response for: " + text,
      audio_base64: ""
    });
  }, 4000);
});

app.listen(3000, () => {
  console.log("Test backend running on port 3000");
});