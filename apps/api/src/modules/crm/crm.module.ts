import { Module } from "@nestjs/common";
import { CompaniesController } from "./companies.controller.js";
import { CompaniesService } from "./companies.service.js";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";
import { DealsController } from "./deals.controller.js";
import { DealsService } from "./deals.service.js";
import { EstimatesController } from "./estimates.controller.js";
import { EstimatesService } from "./estimates.service.js";
import { NotesController } from "./notes.controller.js";
import { NotesService } from "./notes.service.js";
import { MeetingsController } from "./meetings.controller.js";
import { MeetingsService } from "./meetings.service.js";
import { ProposalsController } from "./proposals.controller.js";
import { PublicProposalsController } from "./public-proposals.controller.js";
import { ProposalsService } from "./proposals.service.js";
import { ContractsController } from "./contracts.controller.js";
import { PublicContractsController } from "./public-contracts.controller.js";
import { ContractsService } from "./contracts.service.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { FilesModule } from "../files/files.module.js";

/**
 * One module for the whole CRM surface: companies and contacts are the anchor,
 * deals/estimates/notes/meetings hang off them. Projects is imported so a won
 * deal can be converted into delivery work; Notifications so invites land in
 * the inbox.
 */
@Module({
  imports: [ProjectsModule, NotificationsModule, FilesModule],
  controllers: [
    CompaniesController,
    ContactsController,
    DealsController,
    EstimatesController,
    NotesController,
    MeetingsController,
    ProposalsController,
    PublicProposalsController,
    ContractsController,
    PublicContractsController,
  ],
  providers: [
    CompaniesService,
    ContactsService,
    DealsService,
    EstimatesService,
    NotesService,
    MeetingsService,
    ProposalsService,
    ContractsService,
  ],
})
export class CrmModule {}
