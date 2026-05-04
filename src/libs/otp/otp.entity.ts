import { BeforeInsert, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('otp')
export class Otp {
  @PrimaryColumn()
  phone: string;

  @Column({
    unique: true,
    nullable: false,
  })
  code: number;
  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  sent_at: Date;

  @BeforeInsert()
  generateRandomCode() {
    // Only generate random code if not already set
    if (!this.code) {
      this.code = Math.floor(Math.random() * 9000) + 1000;
    }
  }
}
