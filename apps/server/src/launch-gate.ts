/** The supervisor persists the exact child identity before allowing any DB/loop IO. */
export function awaitLaunch(): Promise<void> {
  if (process.env.CARDIGAN_SUPERVISED !== "1") return Promise.resolve();
  if (!process.send || !process.connected)
    throw new Error("Missing supervisor launch channel");
  return new Promise((resolve) => {
    const disconnected = () => process.exit(1);
    process.once("disconnect", disconnected);
    process.once("message", (message) => {
      if (message !== "start") process.exit(1);
      process.off("disconnect", disconnected);
      resolve();
    });
  });
}
