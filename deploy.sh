#!/data/data/com.termux/files/usr/bin/bash
# Start the phone agent - run this from Termux:Boot or manually

cd ~/phone-agent || cd /data/data/com.termux/files/home/phone-agent || exit 1

# Start proot-distro Ubuntu if not already running
if ! pgrep -f "proot-distro login ubuntu" > /dev/null; then
  proot-distro login ubuntu -- bash -c "cd ~/phone-agent && npm start" &
else
  node agent.js
fi
