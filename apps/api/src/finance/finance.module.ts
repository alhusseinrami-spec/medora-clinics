import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller.js';
import { FinanceController } from './finance.controller.js';
import { InsuranceController } from './insurance.controller.js';

@Module({ controllers: [InvoicesController, FinanceController, InsuranceController] })
export class FinanceModule {}
