import { Controller, Get, Module, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { InternalKeyGuard } from './common/guards/internal-key.guard';
import { ResponseTimeInterceptor } from './common/interceptors/response-time.interceptor';
import { CRITICAL_SERVICES, getRouteSummary, getServiceTargets } from './proxy/routes.proxy';

type ServiceStatus = 'up' | 'down';

@Controller()
export class HealthController {
  @Get('healthz')
  live(): { status: string; uptime_seconds: number } {
    return { status: 'ok', uptime_seconds: Math.round(process.uptime()) };
  }

  @Get('readyz')
  async ready(): Promise<{ status: string; services: Record<string, ServiceStatus> }> {
    const entries = await Promise.all(
      Object.entries(getServiceTargets()).map(async ([name, url]): Promise<[string, ServiceStatus]> => {
        try {
          const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
          return [name, res.ok ? 'up' : 'down'];
        } catch {
          return [name, 'down'];
        }
      }),
    );
    const services = Object.fromEntries(entries) as Record<string, ServiceStatus>;
    if ([...CRITICAL_SERVICES].some((name) => services[name] !== 'up')) {
      throw new ServiceUnavailableException({ status: 'unavailable', services });
    }
    const degraded = Object.values(services).some((s) => s !== 'up');
    return { status: degraded ? 'degraded' : 'ok', services };
  }
}

@Controller('internal')
@UseGuards(InternalKeyGuard)
export class InternalController {
  @Get('routes')
  routes(): { routes: Array<Record<string, unknown>> } {
    return { routes: getRouteSummary() };
  }
}

@Module({
  controllers: [HealthController, InternalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseTimeInterceptor }, InternalKeyGuard],
})
export class AppModule {}
