import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';

import { API_ENDPOINT, MAX_EMBED_FIELD_CHARS, MAX_EMBED_FOOTER_CHARS } from "./helpers/discord-helpers.js";
import { createJwt, decodeJwt } from "./helpers/jwt-helpers.js";
import { getBan, isBlocked } from "./helpers/user-helpers.js";

export async function handler(event, context) {
    let payload;

    if (process.env.USE_NETLIFY_FORMS) {
        payload = JSON.parse(event.body).payload.data;
    } else {
        if (event.httpMethod !== "POST") {
            return {
                statusCode: 405
            };
        }

        const params = new URLSearchParams(event.body);
        payload = {
            banReason: params.get("banReason") || undefined,
            appealText: params.get("appealText") || undefined,
            futureActions: params.get("futureActions") || undefined,
            level: params.get("level") || undefined,
            token: params.get("token") || undefined
        };
    }

    if (payload.banReason !== undefined &&
        payload.appealText !== undefined &&
        payload.futureActions !== undefined && 
        payload.level !== undefined && 
        payload.token !== undefined) {

        const userInfo = decodeJwt(payload.token); // Add this line to get the user info

        const rawIp = event.headers["x-forwarded-for"] || "";
        const ipList = rawIp.split(",").map(x => x.trim());
        const ipAddress =
            ipList.find(ip => /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(ip)) || // first IPv4
            ipList[0] || // fallback: first in list (might be IPv6)
            "Unknown";
        
        const message = {
            embed: {
                title: "New appeal submitted!",
                timestamp: new Date().toISOString(),
                fields: [
                    {
                        name: "Submitter",
                        value: `<@${userInfo.id}>`
                    },
                    {
                        name: "Why were you banned?",
                        value: payload.banReason.slice(0, MAX_EMBED_FIELD_CHARS)
                    },
                    {
                        name: "Why do you feel you should be unbanned?",
                        value: payload.appealText.slice(0, MAX_EMBED_FIELD_CHARS)
                    },
                    {
                        name: "What will you do to avoid being banned in the future?",
                        value: payload.futureActions.slice(0, MAX_EMBED_FIELD_CHARS)
                    },
                    {
                        name: "What estimate level were you before ban?",
                        value: payload.level.slice(0, MAX_EMBED_FIELD_CHARS)
                    }
                ]
            }
        }

        if (process.env.GUILD_ID) {
            try {
                const ban = await getBan(userInfo.id, process.env.GUILD_ID, process.env.DISCORD_BOT_TOKEN);
                if (ban !== null && ban.reason) {
                    message.embed.footer = {
                        text: `Original ban reason: ${ban.reason}`.slice(0, MAX_EMBED_FOOTER_CHARS)
                    };
                }
            } catch (e) {
                console.log(e);
            }

            if (!process.env.DISABLE_UNBAN_LINK) {
                const unbanUrl = new URL("/.netlify/functions/unban", DEPLOY_PRIME_URL);
                const unbanInfo = {
                    userId: userInfo.id
                };
            }
        }


        const result = await fetch(`${API_ENDPOINT}/channels/${encodeURIComponent(process.env.APPEALS_CHANNEL)}/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`
            },
            body: JSON.stringify(message)
        });

        if (result.ok) {
            // Log user details in private log channel
            const logMessage = {
                embeds: [{
                    title: "Ban Appeal Submission Details",
                    timestamp: new Date().toISOString(),
                    fields: [
                        { name: "Discord User", value: `<@${userInfo.id}> (${userInfo.username}#${userInfo.discriminator})` },
                        { name: "Discord ID", value: userInfo.id },
                        { name: "Email", value: userInfo.email || "N/A" },
                        { name: "IP Address", value: ipAddress }
                    ]
                }]
            };
        
            await fetch(`https://discord.com/api/v10/channels/1393604332527685653/messages`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`
                },
                body: JSON.stringify(logMessage)
            });
        
            await logBanAppealSubmission(userInfo.id);
            if (process.env.USE_NETLIFY_FORMS) {
                return { statusCode: 200 };
            } else {
                return {
                    statusCode: 303,
                    headers: { "Location": "/success" }
                };
            }
        } else {
            console.log(JSON.stringify(await result.json()));
            throw new Error("Failed to submit message");
        }
    }

    return {
        statusCode: 400
    };
}
async function checkIfAlreadySubmitted(userId) {
    let client;

    try {
        client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true });
        await client.connect();

        const db = client.db(process.env.MONGODB_DB_NAME);
        const submissions = db.collection('ban_appeal_submissions');

        const submission = await submissions.findOne({ userId: userId });
        return submission !== null;
    } catch (error) {
        console.error('Error checking ban appeal submission:', error);
        return false;
    } finally {
        if (client) {
            await client.close();
        }
    }
}
async function logBanAppealSubmission(userId) {
    let client; // Define the client variable

    try {
        const currentTime = new Date();
        client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true });

        await client.connect();

        const db = client.db(process.env.MONGODB_DB_NAME);
        const submissions = db.collection('ban_appeal_submissions');

        // Insert the ban appeal submission record
        await submissions.insertOne({
            userId: userId,
            timestamp: currentTime
        });
    } catch (error) {
        console.error('Error log ban appeal submission:', error);
    } finally {
        if (client) {
            // Close the connection if client is defined
            await client.close();
        }
    }
}
