import { Service, ServiceStatus } from '@prisma/client';
import { toMoneyString, type MoneyString } from '../common/money/money';

export type PublicServiceView = {
  id: string;
  code: string;
  nameSi: string;
  nameEn: string;
  descriptionSi: string | null;
  descriptionEn: string | null;
  minPrice: MoneyString;
  maxPrice: MoneyString;
  status: ServiceStatus;
};

export type AdminServiceView = PublicServiceView & {
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicServiceView(service: Service): PublicServiceView {
  return {
    id: service.id,
    code: service.code,
    nameSi: service.nameSi,
    nameEn: service.nameEn,
    descriptionSi: service.descriptionSi,
    descriptionEn: service.descriptionEn,
    minPrice: toMoneyString(service.minPrice),
    maxPrice: toMoneyString(service.maxPrice),
    status: service.status,
  };
}

export function toAdminServiceView(service: Service): AdminServiceView {
  return {
    ...toPublicServiceView(service),
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}
