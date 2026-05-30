#!/data/data/com.termux/files/usr/bin/bash

# Start proot Ubuntu
proot-distro login ubuntu -- bash -c "
  cd ~/phone-agent
  npm start &
  # Start nginx if installed
  nginx 2>/dev/null
" &

# Keep Termux from closing
sleep infinity
