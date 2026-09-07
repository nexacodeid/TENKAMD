import fs from 'fs'
import path from 'path'
import te from '../../src/lib/haidar-error.js'
import { updateAssetUrl } from '../../src/lib/haidar-uploader.js'
const pluginConfig = {
    name: 'ganti-haidar2.jpg',
    alias: ['gantihaidar2', 'sethaidar2'],
    category: 'owner',
    description: 'Ganti gambar haidar2.jpg',
    usage: '.ganti-haidar2.jpg (reply/kirim gambar)',
    example: '.ganti-haidar2.jpg',
    isOwner: true,
    isPremium: false,
    isGroup: false,
    isPrivate: false,
    cooldown: 5,
    energi: 0,
    isEnabled: true
}

async function handler(m, { sock }) {
    const isImage = m.isImage || (m.quoted && m.quoted.type === 'imageMessage')
    
    if (!isImage) {
        return m.reply(`🖼️ *ɢᴀɴᴛɪ ᴏᴜʀɪɴ2.ᴊᴘɢ*\n\n> Kirim/reply gambar untuk mengganti\n> File: assets/images/haidar2.jpg`)
    }
    
    try {
        let buffer
        if (m.quoted && m.quoted.isMedia) {
            buffer = await m.quoted.download()
        } else if (m.isMedia) {
            buffer = await m.download()
        }
        
        if (!buffer) {
            return m.reply(`❌ Gagal mendownload gambar`)
        }
        
        await m.reply(`⏳ Sedang mengupload gambar...`)
        try {
            const newUrl = await updateAssetUrl('haidar2', buffer, 'haidar2.jpg')
            m.reply(`✅ *ʙᴇʀʜᴀsɪʟ*\n\n> Gambar haidar2.jpg telah diganti ke URL baru:\n> ${newUrl}\n> Config telah diupdate secara realtime!`)
        } catch (e) {
            m.reply(`❌ Gagal mengupload gambar: ${e.message}`)
        }
    } catch (error) {
        await m.reply(te(m.prefix, m.command, m.pushName))
    }
}

export { pluginConfig as config, handler }