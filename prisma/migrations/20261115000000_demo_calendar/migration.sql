-- CreateEnum
CREATE TYPE "CalendarBookingStatus" AS ENUM ('active', 'cancelled');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "demo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_bn" TEXT,
    "specialty" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_hours" (
    "id" SERIAL NOT NULL,
    "provider_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "provider_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_bookings" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" "CalendarBookingStatus" NOT NULL DEFAULT 'active',
    "rescheduled_from_id" TEXT,
    "rescheduled_to_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_hours_provider_id_weekday_idx" ON "provider_hours"("provider_id", "weekday");

-- CreateIndex
CREATE INDEX "calendar_bookings_patient_id_status_start_at_idx" ON "calendar_bookings"("patient_id", "status", "start_at");

-- CreateIndex
CREATE INDEX "calendar_bookings_provider_id_start_at_idx" ON "calendar_bookings"("provider_id", "start_at");

-- AddForeignKey
ALTER TABLE "provider_hours" ADD CONSTRAINT "provider_hours_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_bookings" ADD CONSTRAINT "calendar_bookings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Constraints the schema language can't express. The partial unique index is what
-- stops two conversations booking one slot at the same moment: the adapter checks
-- first, but only the database can settle a race.
ALTER TABLE "provider_hours" ADD CONSTRAINT "provider_hours_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "provider_hours" ADD CONSTRAINT "provider_hours_range_check"
  CHECK (0 <= "start_minute" AND "start_minute" < "end_minute" AND "end_minute" <= 1440);
ALTER TABLE "calendar_bookings" ADD CONSTRAINT "calendar_bookings_range_check" CHECK ("start_at" < "end_at");
CREATE UNIQUE INDEX "calendar_bookings_one_active_per_slot"
  ON "calendar_bookings"("provider_id", "start_at") WHERE "status" = 'active';
