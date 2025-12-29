// AD MANAGER - Recreated for Native Ads (Top & Bottom)
const AdManager = {

    BANNER_ID: 'ca-app-pub-3940256099942544/6300978111', // Test ID

    async init() {
        console.log("AdManager Init - Version 2.0 (Verified)");
        // Any init logic if needed
    },

    // Show Native Ad at the position of the given element
    async showNativeAd(elementId, adId, width = 320, height = 150) {
        try {
            const el = document.getElementById(elementId);
            if (!el) {
                console.error(`Placeholder ${elementId} not found`);
                return;
            }

            // Get Position
            const rect = el.getBoundingClientRect();
            // Force strict TOP (0) if it's the top ad space, otherwise use calculated
            const topMargin = (adId === 'home_top') ? 0 : Math.round(rect.top);

            // Force strict BOTTOM (0) if it's the bottom space
            const isBottom = rect.top > (window.innerHeight / 2);
            const bottomMargin = isBottom ? 0 : Math.round(window.innerHeight - rect.bottom); // Force 0 for bottom ads

            console.log(`Showing NativeAd [${adId}] at ${isBottom ? 'BOTTOM' : 'TOP'} | Top: ${topMargin}, Bot: ${bottomMargin}`);

            // Hide placeholder content but keep space
            el.style.opacity = '0';

            // Call Native Plugin
            if (window.Capacitor && window.Capacitor.Plugins.NativeAd) {
                await window.Capacitor.Plugins.NativeAd.show({
                    adId: adId,
                    width: width,
                    height: height,
                    topMargin: isBottom ? 0 : topMargin,
                    bottomMargin: isBottom ? bottomMargin : 0,
                    isBottom: isBottom
                });
            } else {
                console.warn("NativeAd Plugin not found");
                el.style.opacity = '1';
                el.innerHTML = "Native Ad Plugin Missing";
            }

        } catch (e) {
            console.error("Error showing Native Ad:", e);
        }
    },

    async hideNativeAd(adId) {
        try {
            if (window.Capacitor && window.Capacitor.Plugins.NativeAd) {
                await window.Capacitor.Plugins.NativeAd.hide({ adId: adId });
            }
        } catch (e) {
            console.error("Error hiding ad:", e);
        }
    },

    async hideAllAds() {
        try {
            if (window.Capacitor && window.Capacitor.Plugins.NativeAd) {
                await window.Capacitor.Plugins.NativeAd.hideAll();
                console.log("All Native Ads Hidden");
            }
        } catch (e) {
            console.error("Error hiding all ads:", e);
        }
    },

    // PROD REWARD ID
    REWARD_VIDEO_ID: 'ca-app-pub-6678790844195434/2296771442',

    // Check Ticket Logic (Restored)
    checkEntryTicket: async function (onSuccess) {
        console.log("Checking Entry Ticket...");

        // If user needs to watch ad to enter
        if (confirm("Watch a short video to enter the Tournament?")) {
            const reward = await this.showRewardVideoAd();

            // If rewarded (or ad failed/skipped but we want to let them in anyway for better UX?)
            if (reward) {
                if (onSuccess) onSuccess();
                return true;
            } else {
                alert("Ad was not completed. Entry denied.");
                return false;
            }
        }
        return false;
    },

    // REWARD VIDEO ADS
    async prepareRewardVideoAd() {
        if (this.isRewardLoaded) return;
        try {
            if (window.Capacitor && window.Capacitor.Plugins.AdMob) {
                await window.Capacitor.Plugins.AdMob.prepareRewardVideoAd({
                    adId: this.REWARD_VIDEO_ID
                });
                this.isRewardLoaded = true;
                console.log("Reward Ad Prepared");
            }
        } catch (e) {
            console.error("Error preparing Reward Ad:", e);
        }
    },

    async showRewardVideoAd() {
        // Ensure prepared
        await this.prepareRewardVideoAd();

        return new Promise(async (resolve) => {
            let hasRewarded = false;

            try {
                if (window.Capacitor && window.Capacitor.Plugins.AdMob) {

                    // Listener for Reward
                    const onReward = window.Capacitor.Plugins.AdMob.addListener('onRewardedVideoAdReward', (info) => {
                        console.log("User Rewarded:", info);
                        hasRewarded = true;
                    });

                    // Listener for Dismiss
                    const onDismiss = window.Capacitor.Plugins.AdMob.addListener('onRewardedVideoAdDismissed', () => {
                        console.log("Ad Dismissed. Rewarded:", hasRewarded);

                        // CRITICAL FIX: Reset load state so next ad can load
                        AdManager.isRewardLoaded = false;

                        // Resolve based on whether reward was captured
                        resolve(hasRewarded);

                        // Cleanup
                        onReward.remove();
                        onDismiss.remove();

                        // Pre-load next ad strictly
                        setTimeout(() => {
                            AdManager.prepareRewardVideoAd();
                        }, 500);
                    });

                    // Trigger Ad
                    await window.Capacitor.Plugins.AdMob.showRewardVideoAd();

                } else {
                    console.warn("AdMob Plugin not found");
                    resolve(true); // Fallback for testing/web
                }
            } catch (e) {
                console.error("Error showing Reward Ad:", e);
                // If error occurs, assume false unless we want to be generous
                resolve(false);
            }
        });
    },

    // Legacy support (redirects to native)
    async showMediumRectangle() { this.showNativeAd('mid-ad-space', 'home_mid'); },
    async showLargeBanner() { this.showNativeAd('bottom-ad-space', 'home_bottom'); }
};
