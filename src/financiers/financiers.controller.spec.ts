import { Test, TestingModule } from '@nestjs/testing';
import { FinanciersController } from './financiers.controller';

describe('FinanciersController', () => {
  let controller: FinanciersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FinanciersController],
    }).compile();

    controller = module.get<FinanciersController>(FinanciersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
