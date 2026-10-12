/* eslint-disable @typescript-eslint/no-unused-vars */
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, HttpServer } from '@config/env.config';
import { EvolutionBot, EvolutionBotSetting, IntegrationSession } from '@prisma/client';
import { describeRemoteHttpError } from '@utils/httpErrorDiagnostics';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';
import { isURL } from 'class-validator';

import { BaseChatbotService } from '../../base-chatbot.service';
import { OpenaiService } from '../../openai/services/openai.service';

export class EvolutionBotService extends BaseChatbotService<EvolutionBot, EvolutionBotSetting> {
  private openaiService: OpenaiService;

  constructor(
    waMonitor: WAMonitoringService,
    prismaRepository: PrismaRepository,
    configService: ConfigService,
    openaiService: OpenaiService,
  ) {
    super(waMonitor, prismaRepository, 'EvolutionBotService', configService);
    this.openaiService = openaiService;
  }

  /**
   * Get the bot type identifier
   */
  protected getBotType(): string {
    return 'evolution';
  }

  /**
   * Send a message to the Evolution Bot API
   */
  protected async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    settings: EvolutionBotSetting,
    bot: EvolutionBot,
    remoteJid: string,
    pushName: string,
    content: string,
    msg?: any,
  ): Promise<void> {
    try {
      const payload: any = {
        inputs: {
          sessionId: session.id,
          remoteJid: remoteJid,
          pushName: pushName,
          fromMe: msg?.key?.fromMe,
          instanceName: instance.instanceName,
          serverUrl: this.configService.get<HttpServer>('SERVER').URL,
          apiKey: instance.token,
        },
        query: content,
        conversation_id: session.sessionId === remoteJid ? undefined : session.sessionId,
        user: remoteJid,
      };

      if (this.isAudioMessage(content) && msg) {
        try {
          this.logger.debug(`[EvolutionBot] Downloading audio for Whisper transcription`);
          const transcription = await this.openaiService.speechToText(msg, instance);
          if (transcription) {
            payload.query = `[audio] ${transcription}`;
          }
        } catch (err) {
          this.logger.error(`[EvolutionBot] Failed to transcribe audio: ${err}`);
        }
      }

      if (this.isImageMessage(content) && msg) {
        const media = content.split('|');

        if (msg.message.mediaUrl || msg.message.base64) {
          payload.files = [
            {
              type: 'image',
              url: msg.message.base64 || msg.message.mediaUrl,
            },
          ];
        } else {
          payload.files = [
            {
              type: 'image',
              url: media[1].split('?')[0],
            },
          ];
        }

        payload.query = media[2] || content;
      }

      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.client.presenceSubscribe(remoteJid);
        await instance.client.sendPresenceUpdate('composing', remoteJid);
      }

      const endpoint = bot.apiUrl;

      if (!endpoint) {
        this.logger.error(
          `[EvolutionBot] No endpoint (apiUrl) configured for bot "${bot.id}" on instance "${instance.instanceName}". ` +
            `Configure a valid bot URL before using this integration.`,
        );
        return;
      }

      if (!isURL(endpoint, { require_tld: false })) {
        this.logger.error(
          `[EvolutionBot] Invalid apiUrl "${endpoint}" configured for bot "${bot.id}" on instance "${instance.instanceName}". ` +
            `The url must be an absolute http(s) endpoint of the bot service.`,
        );
        return;
      }

      let headers: any = {
        'Content-Type': 'application/json',
      };

      if (bot.apiKey) {
        headers = {
          ...headers,
          Authorization: `Bearer ${bot.apiKey}`,
        };
      }

      let response: any;
      try {
        response = await axios.post(endpoint, payload, {
          headers,
        });
      } catch (error) {
        this.logHttpRequestError('POST', endpoint, error, instance, bot, msg);
        if (instance.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.client.sendPresenceUpdate('paused', remoteJid).catch(() => undefined);
        }
        return;
      }

      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.client.sendPresenceUpdate('paused', remoteJid);
      }

      let message = response?.data?.message;
      const rawLinkPreview = response?.data?.linkPreview;

      // Validate linkPreview is boolean and default to true for backward compatibility
      const linkPreview = typeof rawLinkPreview === 'boolean' ? rawLinkPreview : true;

      if (message && typeof message === 'string' && message.startsWith("'") && message.endsWith("'")) {
        const innerContent = message.slice(1, -1);
        if (!innerContent.includes("'")) {
          message = innerContent;
        }
      }

      if (message) {
        // Use the base class method that handles splitMessages functionality
        await this.sendMessageWhatsApp(instance, remoteJid, message, settings, linkPreview);
      } else {
        this.logger.warn(`[EvolutionBot] No message content received from bot response`);
      }

      // Send telemetry
      sendTelemetry('/message/sendText');
    } catch (error) {
      this.logger.error(`Error in sendMessageToBot: ${error.message || JSON.stringify(error)}`);
      return;
    }
  }

  /**
   * Logs a failed HTTP request to the Evolution Bot without leaking credentials.
   * Distinguishes configuration errors (404/401/403) from network failures so the
   * actual cause can be identified from the logs.
   */
  private logHttpRequestError(
    method: string,
    url: string,
    error: any,
    instance: any,
    bot: EvolutionBot,
    msg?: any,
  ): void {
    const instanceName = instance?.instanceName ?? '-';
    const messageId = msg?.key?.id ?? '-';
    const remoteJid = msg?.key?.remoteJid ?? '-';

    const base =
      `[EvolutionBot] HTTP request failed: method=${method} url=${url} ` +
      `instance=${instanceName} bot=${bot?.id ?? '-'} messageId=${messageId} remoteJid=${remoteJid}`;

    this.logger.error(`${base} ${describeRemoteHttpError(error)}`);
  }
}
