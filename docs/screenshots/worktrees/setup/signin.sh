#!/bin/bash
# Signs the app on :182 in by URL to the throwaway dashboard, then sets the Repository screen's SSH target to the
# throwaway sshd (hc82) and opens the synthetic repository. Coordinates are for the 1280 × 820 window.
X=/tmp/hc82/x.sh
sleep 6
$X click 828 566 1.5; $X click 759 380; $X click 640 407; $X type "http://127.0.0.2:19482"; $X click 849 611 2
$X click 640 412; $X type fixture; $X click 640 484; $X type fixture-pass-123; $X click 814 576 20
$X click 807 647 10; $X click 846 752 6
$X click 28 452 2; $X click 633 121; $X type hc82; $X click 914 121 1
$X click 750 124; $X type /tmp/hc82/srv/weather-api; $X key Return 6
