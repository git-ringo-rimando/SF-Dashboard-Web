@echo off
echo Adding firewall rule for SF Dashboard...
netsh advfirewall firewall add rule name="SF Dashboard" dir=in action=allow protocol=TCP localport=3000
echo Done.
pause
