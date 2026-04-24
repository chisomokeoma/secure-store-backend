import { Test, TestingModule } from '@nestjs/testing';
import { FinanciersService } from './financiers.service';

describe('FinanciersService', () => {
  let service: FinanciersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FinanciersService],
    }).compile();

    service = module.get<FinanciersService>(FinanciersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
