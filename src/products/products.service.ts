import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { PageMetaDto } from '../common/dto/page-meta.dto';
import { PageOptionsDto } from '../common/dto/page-options.dto';
import { PageDto } from '../common/dto/page.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductImage } from './entities/product-image.entity';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger('ProductsService');

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(ProductImage)
    private readonly productImagesRepository: Repository<ProductImage>,
    private readonly dataSource: DataSource,
  ) {}

  async create(createProductDto: CreateProductDto) {
    try {
      const { images = [], ...productDetails } = createProductDto;

      const product = this.productsRepository.create({
        ...productDetails,
        images: images.map((image) =>
          this.productImagesRepository.create({ url: image }),
        ),
      });
      await this.productsRepository.save(product);

      return product;
    } catch (error) {
      this.handleDBException(error);
    }
  }

  async findAll(pageOptionsDto: PageOptionsDto) {
    const queryBuilder = this.productsRepository.createQueryBuilder('product');

    queryBuilder
      .orderBy('product.name', pageOptionsDto.order)
      .skip((pageOptionsDto.page - 1) * pageOptionsDto.take)
      .take(pageOptionsDto.take)
      .leftJoinAndSelect('product.images', 'images');

    const itemCount = await queryBuilder.getCount();
    const { entities } = await queryBuilder.getRawAndEntities();

    const pageMetaDto = new PageMetaDto({ itemCount, pageOptionsDto });

    return new PageDto(entities, pageMetaDto);
  }

  async findOne(term: string) {
    let product: Product;

    if (isUUID(term)) {
      product = await this.productsRepository.findOne({
        where: { id: term },
        relations: ['images'],
      });
    } else {
      product = await this.productsRepository.findOne({
        where: { slug: term },
        relations: ['images'],
      });
    }

    if (!product) {
      throw new NotFoundException(`Product with ID or slug ${term} not found`);
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto) {
    const { images, ...toUpdate } = updateProductDto;

    const product = await this.productsRepository.preload({
      id: id,
      ...toUpdate,
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (images) {
        await queryRunner.manager.delete(ProductImage, { product: { id: id } });

        product.images = images.map((image) =>
          this.productImagesRepository.create({ url: image }),
        );
      } else {
        product.images = await this.productImagesRepository.findBy({
          product: { id: id },
        });
      }

      await queryRunner.manager.save(product);

      await queryRunner.commitTransaction();
      await queryRunner.release();

      return product;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
      this.handleDBException(error);
    }
  }

  async remove(id: string) {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);

    return product;
  }

  private handleDBException(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException(error.detail);
    }

    throw new InternalServerErrorException(error.message);
  }
}
