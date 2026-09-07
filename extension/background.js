// background.js
// This is the "service worker" — a background script that runs behind the
// scenes in the extension. It doesn't have access to the webpage itself,
// but it CAN listen for keyboard shortcuts and send messages to content
// scripts that ARE running on the webpage.

// Listen for any keyboard command defined in manifest.json's "commands" section.
chrome.commands.onCommand.addListener((command) => {
  // "command" is just the name (a string) of whichever shortcut was pressed.
  // We only care about the one called "toggle-overlay".
  if (command === "toggle-overlay") {

    // Find the tab that is currently active and focused in the current window,
    // so we know WHERE to send our message.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];

      // Safety check: make sure we actually found a tab before messaging it.
      if (activeTab && activeTab.id !== undefined) {
        // Send a message to the content script running in that tab.
        // The content script (content.js) is listening for this message
        // and will show/hide the overlay when it receives it.
        chrome.tabs.sendMessage(activeTab.id, { action: "toggle" });
      }
    });
  }
});