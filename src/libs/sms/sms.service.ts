import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { URLSearchParams } from 'url';

/**
 * Available SMS providers
 */
export enum SmsProvider {
  ASANAK = 'asanak',
  GHASEDAK = 'ghasedak',
}

/**
 * SMS sending options
 */
export interface SendSmsOptions {
  receptor: string;
  message: string;
  provider?: SmsProvider;
}

@Injectable()
export class SmsService {
  // SMS configuration
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly source: string;
  private readonly apiKey: string;
  private readonly lineNumber: string;

  // Current provider
  private readonly provider: SmsProvider;

  constructor(private configService: ConfigService) {
    // Get the SMS provider from config
    this.provider =
      (this.configService.get<string>('sms.provider') as SmsProvider) ||
      SmsProvider.ASANAK;

    // Initialize SMS configuration from the config service
    this.baseUrl = this.configService.get<string>('sms.baseUrl') || '';
    this.username = this.configService.get<string>('sms.username') || '';
    this.password = this.configService.get<string>('sms.password') || '';
    this.source = this.configService.get<string>('sms.source') || '';
    this.apiKey = this.configService.get<string>('sms.apiKey') || '';
    this.lineNumber = this.configService.get<string>('sms.lineNumber') || '';
  }

  /**
   * Send SMS using the configured provider
   * @param options - SMS sending options
   * @returns Response from the SMS service
   */
  async sendSms(
    options: SendSmsOptions,
  ): Promise<{ response: any; provider: SmsProvider }> {
    // Check if SMS is configured
    if (!this.baseUrl || this.baseUrl.trim() === '') {
      console.warn('SMS service not configured - skipping SMS send');
      return {
        response: { status: 'skipped', reason: 'not_configured' },
        provider: this.provider,
      };
    }

    // Use the specified provider or fall back to the configured one
    const provider = options.provider || this.provider;
    let response: any;

    switch (provider) {
      case SmsProvider.GHASEDAK:
        response = await this.sendWithGhasedak(
          options.receptor,
          options.message,
        );
        break;
      case SmsProvider.ASANAK:
      default:
        response = await this.sendWithAsanak(options.receptor, options.message);
        break;
    }

    return { response, provider };
  }

  /**
   * Internal method to send SMS using Asanak provider
   */
  private async sendWithAsanak(
    receptor: string,
    message: string,
  ): Promise<any> {
    const params = new URLSearchParams();
    params.append('username', this.username);
    params.append('password', this.password);
    params.append('source', this.source);
    params.append('destination', receptor);
    params.append('message', message);

    const url = new URL('webservice/v1rest/sendsms', this.baseUrl);
    const response = await axios.post(url.href, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  }

  /**
   * Internal method to send SMS using Ghasedak provider
   */
  private async sendWithGhasedak(
    receptor: string,
    message: string,
  ): Promise<any> {
    const url = `${this.baseUrl}/SendSingleSMS`;

    const payload = {
      lineNumber: this.lineNumber,
      receptor,
      message,
      // Optional fields can be added if needed
      sendDate: new Date().toISOString(),
      clientReferenceId: `${Date.now()}`,
      udh: false,
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        ApiKey: this.apiKey,
      },
    });

    return response.data;
  }
}
