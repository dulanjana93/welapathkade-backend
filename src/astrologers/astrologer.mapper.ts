import {
  AstrologerProfile,
  AstrologerProfileStatus,
  AstrologerService,
  AstrologerServiceStatus,
  Service,
  ServiceStatus,
} from '@prisma/client';
import { toMoneyString, type MoneyString } from '../common/money/money';

export type AstrologerServicePublicView = {
  serviceId: string;
  code: string;
  nameSi: string;
  nameEn: string;
  descriptionSi: string | null;
  descriptionEn: string | null;
  price: MoneyString;
  status: AstrologerServiceStatus;
};

export type PublicAstrologerListItem = {
  id: string;
  displayName: string;
  bio: string | null;
  experienceYears: number;
  photo: string | null;
  city: string | null;
  district: string | null;
  status: AstrologerProfileStatus;
  services: AstrologerServicePublicView[];
};

export type PublicAstrologerDetail = PublicAstrologerListItem;

export type OwnAstrologerProfileView = {
  id: string;
  displayName: string;
  bio: string | null;
  experienceYears: number;
  photo: string | null;
  city: string | null;
  district: string | null;
  status: AstrologerProfileStatus;
  isComplete: boolean;
  isDiscoverable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OwnAstrologerServiceView = {
  id: string;
  serviceId: string;
  code: string;
  nameSi: string;
  nameEn: string;
  minPrice: MoneyString;
  maxPrice: MoneyString;
  price: MoneyString;
  status: AstrologerServiceStatus;
  serviceStatus: ServiceStatus;
  createdAt: Date;
  updatedAt: Date;
};

type ServiceLink = AstrologerService & { service: Service };

export function mapPublicServiceLink(
  link: ServiceLink,
): AstrologerServicePublicView {
  return {
    serviceId: link.serviceId,
    code: link.service.code,
    nameSi: link.service.nameSi,
    nameEn: link.service.nameEn,
    descriptionSi: link.service.descriptionSi,
    descriptionEn: link.service.descriptionEn,
    price: toMoneyString(link.price),
    status: link.status,
  };
}

export function toPublicAstrologerView(
  profile: AstrologerProfile,
  services: ServiceLink[],
): PublicAstrologerDetail {
  return {
    id: profile.id,
    displayName: profile.displayName,
    bio: profile.bio,
    experienceYears: profile.experienceYears,
    photo: profile.photo,
    city: profile.city,
    district: profile.district,
    status: profile.status,
    services: services.map(mapPublicServiceLink),
  };
}

export function computeProfileCompleteness(profile: AstrologerProfile): boolean {
  return profile.displayName.trim().length >= 2;
}

export function toOwnProfileView(
  profile: AstrologerProfile,
  options: { hasActiveService: boolean; userActive: boolean },
): OwnAstrologerProfileView {
  const isComplete =
    computeProfileCompleteness(profile) && options.hasActiveService;
  const isDiscoverable =
    isComplete &&
    profile.status === AstrologerProfileStatus.ACTIVE &&
    options.userActive;

  return {
    id: profile.id,
    displayName: profile.displayName,
    bio: profile.bio,
    experienceYears: profile.experienceYears,
    photo: profile.photo,
    city: profile.city,
    district: profile.district,
    status: profile.status,
    isComplete,
    isDiscoverable,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function toOwnServiceView(link: ServiceLink): OwnAstrologerServiceView {
  return {
    id: link.id,
    serviceId: link.serviceId,
    code: link.service.code,
    nameSi: link.service.nameSi,
    nameEn: link.service.nameEn,
    minPrice: toMoneyString(link.service.minPrice),
    maxPrice: toMoneyString(link.service.maxPrice),
    price: toMoneyString(link.price),
    status: link.status,
    serviceStatus: link.service.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}
