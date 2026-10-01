import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { initMonitoring, reportError } from './config/monitoring';
import { disconnectStore, initStore } from './config/store';
import { verifySmtpConnection } from './services/email.service';
import { checkRazorpayConfig } from './services/payment.service';
import { startPendingPaymentSweep, stopPendingPaymentSweep } from './services/order.service';

async function bootstrap(): Promise<void> {
  initMonitoring();
  initStore();
  await connectDatabase();

  // Logs half-set, mismatched, or test-in-production Razorpay keys. Never
  // blocks boot: COD keeps working without online payment.
  void checkRazorpayConfig();
  // Signs in to Gmail so a bad App Password shows in the boot log. Not awaited:
  // it never delays listening, and a failure only warns.
  void verifySmtpConnection();
  // Expires online orders left unpaid and releases their stock.
  startPendingPaymentSweep();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
    logger.info(`Environment: ${env.NODE_ENV}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down.`);
    stopPendingPaymentSweep();
    server.close(async () => {
      await disconnectDatabase();
      await disconnectStore();
      process.exit(0);
    });
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
    reportError(reason);
  });
}

bootstrap().catch((error) => {
  logger.error('Failed to start the API', error);
  process.exit(1);
});
