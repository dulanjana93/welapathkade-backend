-- Phase 1A: add COMPLETED to Consultation.status (additive; existing rows unaffected).
ALTER TABLE `Consultation`
    MODIFY `status` ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'COMPLETED') NOT NULL DEFAULT 'PENDING';
