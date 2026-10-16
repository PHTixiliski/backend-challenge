import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  ready(): {
    status: string;
    checks: {
      postgres: string;
      sqs: string;
    };
  } {
    return {
      status: 'not_ready',
      checks: {
        postgres: 'not_configured',
        sqs: 'not_configured',
      },
    };
  }
}
