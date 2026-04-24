// import { Injectable, NotFoundException } from '@nestjs/common';
// import { PrismaService } from '../prisma/prisma.service';


// @Injectable()
// export class CommoditiesService {
//     constructor(private prisma: PrismaService) { }

//     async getMyCommodities(clientId?: string) {
//         let user = clientId ? { id: clientId } : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
//         if (!user) return [];

//         const receipts = await this.prisma.receipt.findMany({
//             where: { clientId: user.id },
//             include: { commodity: true }
//         });

//         const map = new Map<string, any>();
//         for (const r of receipts) {
//             if (!map.has(r.commodityId)) {
//                 map.set(r.commodityId, { id: r.commodityId, name: r.commodity.name, totalQuantity: 0, availableQuantity: 0 });
//             }
//             const data = map.get(r.commodityId);
//             data.totalQuantity += r.quantity;
//             data.availableQuantity += (r.quantityAvailable || 0);
//         }
//         return Array.from(map.values());
//     }

//     async getCommodityOverview(id: string, clientId?: string) {
//         const user = clientId ? { id: clientId } : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
//         const receipts = await this.prisma.receipt.findMany({
//             where: { commodityId: id, clientId: user?.id }
//         });
//         const commodity = await this.prisma.commodity.findUnique({ where: { id } });
//         if (!commodity) throw new NotFoundException('Commodity not found');

//         const totalQuantity = receipts.reduce((sum, r) => sum + r.quantity, 0);
//         const availableQuantity = receipts.reduce((sum, r) => sum + (r.quantityAvailable || 0), 0);

//         return { id, name: commodity.name, totalQuantity, availableQuantity };
//     }

//     async getCommodityReceipts(id: string) {
//         return this.prisma.receipt.findMany({
//             where: { commodityId: id },
//             include: { warehouse: true }
//         }).then(res => res.map(r => ({
//             id: r.id,
//             receiptNumber: r.receiptNumber,
//             quantity: r.quantityAvailable,
//             status: r.status,
//             warehouse: r.warehouse.name
//         })));
//     }
// }


import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommoditiesService {
    constructor(private prisma: PrismaService) { }

    async getMyCommodities(clientId?: string) {
        let user = clientId ? { id: clientId } : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
        if (!user) return [];

        const receipts = await this.prisma.receipt.findMany({
            where: { clientId: user.id },
            include: { commodity: true }
        });

        const map = new Map<string, any>();
        for (const r of receipts) {
            if (!map.has(r.commodityId)) {
                map.set(r.commodityId, { id: r.commodityId, name: r.commodity.name, totalQuantity: 0, availableQuantity: 0 });
            }
            const data = map.get(r.commodityId);
            data.totalQuantity += r.quantity;
            data.availableQuantity += (r.quantity || 0); // 👈 fixed
        }
        return Array.from(map.values());
    }

    async getCommodityOverview(id: string, clientId?: string) {
        const user = clientId ? { id: clientId } : await this.prisma.user.findFirst({ where: { email: 'demo@securestore.com' } });
        const receipts = await this.prisma.receipt.findMany({
            where: { commodityId: id, clientId: user?.id }
        });
        const commodity = await this.prisma.commodity.findUnique({ where: { id } });
        if (!commodity) throw new NotFoundException('Commodity not found');

        const totalQuantity = receipts.reduce((sum, r) => sum + r.quantity, 0);
        const availableQuantity = receipts.reduce((sum, r) => sum + (r.quantity || 0), 0); // 👈 fixed

        return { id, name: commodity.name, totalQuantity, availableQuantity };
    }

    async getCommodityReceipts(id: string) {
        return this.prisma.receipt.findMany({
            where: { commodityId: id },
            include: { warehouse: true }
        }).then(res => res.map(r => ({
            id: r.id,
            receiptNumber: r.receiptNumber,
            quantity: r.quantity, // 👈 fixed
            status: r.status,
            warehouse: r.warehouse.name
        })));
    }
}