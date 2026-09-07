import { getAssetBuffer } from "../../src/lib/haidar-asset-manager.js";
import config from "../../config.js"

const pluginConfig = {
    name: "sc",
    alias: ["script"],
    category: "main",
    description: "Link script bot wa terbaru",
    usage: ".sc",
    example: ".sc",
    isPremium: false,
    isOwner: false,
    isBanned: false,
    isAdmin: false,
    cooldown: 10,
    energi: 0,
    isBotAdmin: false,
    isEnabled: true
}

async function handler(m, { sock }) {
    return await sock.sendMessage(m.chat, {
        image: getAssetBuffer("haidar"),
        caption: `🌾 Halo kak *${m.pushName}*
        
Untuk asli dari bot ini, kamu bisa dapatkan melalui link, nanti kamu tinggal cari kata kunci *TENKA MD*`,
        footer: "💬 Link ini nanti akan mengarahkan kamu ke channel Youtube kami",
        interactiveButtons: [
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "🥐 Youtube Haidar",
                    url: "https://www.youtube.com/@haidarmahiruofficial",
                    merchant_url: "https://www.youtube.com/@haidarmahiruofficial"
                })
            },
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "🥐 Youtube Haidar",
                    url: "https://www.youtube.com/@Haidarbotke2",
                    merchant_url: "https://www.youtube.com/@Haidarbotke2"
                })
            },
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "🥐 Youtube Danz Nano",
                    url: "https://youtube.com/@danzxnano?si=DQPNHNCktzXqoo-I",
                    merchant_url: "https://youtube.com/@danzxnano?si=DQPNHNCktzXqoo-I"
                })
            }
        ]

    }, { quoted: m })
}

export { pluginConfig as config, handler }
