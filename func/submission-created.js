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
        
        const userInfo = decodeJwt(payload.token);
        if (isBlocked(userInfo.id)) {
            return {
                statusCode: 303,
                headers: {
                    "Location": `/error?msg=${encodeURIComponent("You cannot submit ban appeals with this Discord account.")}`,
                },
            };
        }
        const hasSubmittedAppeal = await hasUserSubmittedAppeal(userInfo.id);
        if (hasSubmittedAppeal) {
            const remainingTime = calculateRemainingTime(hasSubmittedAppeal.timestamp);
            const submissionResult = await hasUserSubmittedAppeal(userInfo.id);
            return {
                statusCode: 303,
                headers: {
                    "Location": `/error?msg=${encodeURIComponent(`You have already submitted a ban appeal. You must wait ${formatTime(remainingTime)} before submitting another appeal.`)}`,
                },
            };
        }
        
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
            await logBanAppealSubmission(userInfo.id);
            if (process.env.USE_NETLIFY_FORMS) {
                return {
                    statusCode: 200
                };
            } else {
                return {
                    statusCode: 303,
                    headers: {
                        "Location": "/success"
                    }
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
async function hasUserSubmittedAppeal(userId) {
    let client;
    try {
        client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true });
        await client.connect();

        const db = client.db(process.env.MONGODB_DB_NAME);
        const submissions = db.collection('ban_appeal_submissions');

        const currentTime = new Date();
        const threeWeeksAgo = new Date(currentTime.getTime() - (21 * 24 * 60 * 60 * 1000));
        const recentSubmission = await submissions.findOne({
            userId: userId,
            timestamp: { $gte: threeWeeksAgo }
        });
    
        return recentSubmission !== null;
    }
    

        return recentSubmission !== null;
    } catch (error) {
        console.error('Error checking ban appeal submission:', error);
        return false;
    } finally {
        if (client) {
            await client.close();
        }
    }
}
function calculateRemainingTime(submissionTimestamp) {
    const currentTime = new Date();
    const nextSubmissionTime = new Date(submissionTimestamp.getTime() + (21 * 24 * 60 * 60 * 1000));
    return nextSubmissionTime - currentTime;
}
function formatTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000) % 60;
    const minutes = Math.floor(milliseconds / (1000 * 60)) % 60;
    const hours = Math.floor(milliseconds / (1000 * 60 * 60)) % 24;
    const days = Math.floor(milliseconds / (1000 * 60 * 60 * 24));

    const parts = [];
    if (days > 0) {
        parts.push(`${days} day${days > 1 ? 's' : ''}`);
    }
    if (hours > 0) {
        parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    }
    if (minutes > 0) {
        parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    }
    if (seconds > 0) {
        parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
    }

    return parts.join(', ');
}
