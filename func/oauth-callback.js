import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';

import { getUserInfo, getBan, isBlocked } from "./helpers/user-helpers.js";
import { createJwt } from "./helpers/jwt-helpers.js";

function parseCookies(str) {
    return str
        .split(';')
        .map(v => v.split('='))
        .reduce((acc, v) => {
            acc[v[0]] = v[1];
            return acc;
        }, {});
}

function verifyCsrf(event) {
    if (event.queryStringParameters.state !== undefined && event.headers.cookie !== undefined) {
        const cookies = parseCookies(event.headers.cookie);
        if (cookies["__Secure-CSRFState"] !== undefined) {
            return cookies["__Secure-CSRFState"] === event.queryStringParameters.state;
        }
    }

    return false;
}

export async function handler(event, context) {
    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405
        };
    }

    if (verifyCsrf(event)) {
        if (event.queryStringParameters.code !== undefined) {
            const result = await fetch("https://discord.com/api/oauth2/token", {
                method: "POST",
                body: new URLSearchParams({
                    client_id: process.env.DISCORD_CLIENT_ID,
                    client_secret: process.env.DISCORD_CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code: event.queryStringParameters.code,
                    redirect_uri: new URL(event.path, DEPLOY_PRIME_URL),
                    scope: "identify email"
                })
            });

            const data = await result.json();
    
            if (!result.ok) {
                console.log(data);
                throw new Error("Failed to get user access token");
            }
            const user = await getUserInfo(data.access_token);
            // Call logBanAppealSubmission after fetching user info
            const submissionResult = await logBanAppealSubmission(user.id);

            if (submissionResult.error) {
                return {
                    statusCode: 303,
                    headers: {
                        "Location": `/error?msg=${encodeURIComponent(submissionResult.error)}`,
                    },
                };
            }
            if (isBlocked(user.id)) {
                return {
                    statusCode: 303,
                    headers: {
                        "Location": `/error?msg=${encodeURIComponent("You cannot submit ban appeals with this Discord account.")}`,
                    },
                };
            }
    
            if (process.env.GUILD_ID && !process.env.SKIP_BAN_CHECK) {
                const ban = await getBan(user.id, process.env.GUILD_ID, process.env.DISCORD_BOT_TOKEN);
                if (ban === null) {
                    return {
                        statusCode: 303,
                        headers: {
                            "Location": "/error"
                        }
                    };
                }
            }
            const userPublic = {
                id: user.id,
                avatar: user.avatar,
                username: user.username,
                discriminator: user.discriminator,
                email: user.email
            };
    
            return {
                statusCode: 303,
                headers: {
                    "Location": `/form?token=${encodeURIComponent(createJwt(userPublic, data.expires_in))}`
                }
            };
        } else {
            return {
                statusCode: 400
            };
        }
    } else {
        return {
            statusCode: 403
        };
    }
}
async function logBanAppealSubmission(userId) {
    let client;
    try {
        const currentTime = new Date();
        client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true });

        await client.connect();

        const db = client.db(process.env.MONGODB_DB_NAME);
        const submissions = db.collection('ban_appeal_submissions');

        const threeWeeksAgo = new Date(currentTime.getTime() - (21 * 24 * 60 * 60 * 1000));
        const recentSubmission = await submissions.findOne({
            userId: userId,
            timestamp: { $gte: threeWeeksAgo }
        });

        if (recentSubmission) {
            const timeUntilNextSubmission = new Date(recentSubmission.timestamp.getTime() + (21 * 24 * 60 * 60 * 1000));
            const remainingTime = timeUntilNextSubmission - currentTime;
            return { error: `You must wait ${formatTime(remainingTime)} before submitting another appeal.` };
        } else {
            return {}; // No error, user can proceed
        }
    } catch (error) {
        console.error('Error log ban appeal submission:', error);
        return { error: "An error occurred while processing your ban appeal submission." };
    } finally {
        if (client) {
            await client.close();
        }
    }
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
