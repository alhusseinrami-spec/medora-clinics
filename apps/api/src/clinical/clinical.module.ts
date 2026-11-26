import { Module } from '@nestjs/common';
import { SpecialtyModule } from '../specialty/specialty.controller.js';
import { ConsultationsController } from './consultations.controller.js';
import { PrescriptionsController } from './prescriptions.controller.js';
import { DocumentsController } from './documents.controller.js';
import { RefillsController } from './refills.controller.js';

@Module({ imports: [SpecialtyModule], controllers: [ConsultationsController, PrescriptionsController, DocumentsController, RefillsController] })
export class ClinicalModule {}
