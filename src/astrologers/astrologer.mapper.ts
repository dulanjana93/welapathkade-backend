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

export type RatingSummaryView = {
  /** Null when there are no eligible reviews — never a default 5.0. */
  averageRating: number | null;
  reviewCount: number;
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
  /** Manual presence: accepting new requests (not slot availability). */
  isOnline: boolean;
  services: AstrologerServicePublicView[];
  ratingSummary: RatingSummaryView;
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
  isOnline: boolean;
  isComplete: boolean;
  isDiscoverable: boolean;
  ratingSummary: RatingSummaryView;
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
  ratingSummary: RatingSummaryView = {
    averageRating: null,
    reviewCount: 0,
  },
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
    isOnline: profile.isOnline === true,
    services: services.map(mapPublicServiceLink),
    ratingSummary,
  };
}

export function computeProfileCompleteness(
  profile: AstrologerProfile,
): boolean {
  return profile.displayName.trim().length >= 2;
}

export function toOwnProfileView(
  profile: AstrologerProfile,
  options: {
    hasActiveService: boolean;
    userActive: boolean;
    ratingSummary?: RatingSummaryView;
  },
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
    isOnline: profile.isOnline === true,
    isComplete,
    isDiscoverable,
    ratingSummary: options.ratingSummary ?? {
      averageRating: null,
      reviewCount: 0,
    },
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
