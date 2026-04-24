// import { Injectable } from '@nestjs/common';

// @Injectable()
// export class PrismaService { }

import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';


@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
    constructor() {
        // super();
        const adapter = new PrismaPg({
            connectionString: process.env.DATABASE_URL,
        });
        super({ adapter });

    }
    async onModuleInit() {
        await this.$connect();
    }
}
