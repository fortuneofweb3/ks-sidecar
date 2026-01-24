export async function sendNotification(
    amount: number,
    count: number,
    signature: string
): Promise<void> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        const payload = {
            embeds: [{
                title: "💰 Rent Reclaimed!",
                color: 5763719, // Green
                fields: [
                    {
                        name: "Items Closed",
                        value: `${count} accounts`,
                        inline: true
                    },
                    {
                        name: "SOL Recovered",
                        value: `${amount.toFixed(5)} SOL`,
                        inline: true
                    },
                    {
                        name: "Transaction",
                        value: `[View on Solscan](https://solscan.io/tx/${signature})`
                    }
                ],
                timestamp: new Date().toISOString()
            }]
        };

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e: any) {
        console.error(`[Notifier] Failed to send Discord notification: ${e.message}`);
    }
}
