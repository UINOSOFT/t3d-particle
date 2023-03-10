import * as t3d from "t3d";
import { Utils } from "./Utils.js";
import { ShaderAttribute } from "../helpers/ShaderAttribute.js";
import { Shaders } from "../shaders/Shaders.js";
import { ParticleProperties } from "../ParticleProperties.js";
import { ParticleEmitter } from "./ParticleEmitter.js";
import { AbstractParticleGroup } from "./AbstractParticleGroup.js";

export class ParticleGroup extends AbstractParticleGroup {

	constructor(options) {
		let utils = Utils,
			types = utils.types;

		// Ensure we have a map of options to play with
		options = Utils.ensureTypedArg(options, types.OBJECT, {});

		super(options);

		this.maxParticleCount = utils.ensureTypedArg(options.maxParticleCount, types.NUMBER, null);
		if (this.maxParticleCount === null) {
			console.warn('ParticleGroup: No maxParticleCount specified. Adding emitters after rendering will probably cause errors.');
		}

		// Set properties used in the uniforms map, starting with the
		// texture stuff.

		this.textureFrames = Utils.ensureInstanceOf(options.texture.frames, t3d.Vector2, new t3d.Vector2(1, 1));
		this.textureFrames.max(new t3d.Vector2(1, 1));

		this.textureFrameCount = Utils.ensureTypedArg(options.texture.frameCount, types.NUMBER, this.textureFrames.x * this.textureFrames.y);
		this.textureLoop = Utils.ensureTypedArg(options.texture.loop, types.NUMBER, 1);

		// Create the ShaderMaterial instance that'll help render the
		// particles.

		this.material = new t3d.ShaderMaterial({
			defines: {
				HAS_PERSPECTIVE: this.hasPerspective,
				COLORIZE: this.colorize,
				VALUE_OVER_LIFETIME_LENGTH: ParticleProperties.valueOverLifetimeLength,

				SHOULD_ROTATE_TEXTURE: false,
				SHOULD_ROTATE_PARTICLES: false,
				SHOULD_WIGGLE_PARTICLES: false,

				SHOULD_CALCULATE_SPRITE: this.textureFrames.x > 1 || this.textureFrames.y > 1
			},
			uniforms: {
				tex: null,
				textureAnimation: [
					this.textureFrames.x,
					this.textureFrames.y,
					this.textureFrameCount,
					Math.max(Math.abs(this.textureLoop), 1.0)
				],
				scale: utils.ensureTypedArg(options.scale, types.NUMBER, 300),
				deltaTime: 0,
				runTime: 0
			},
			vertexShader: Shaders.vertex,
			fragmentShader: Shaders.fragment
		});
		this._setMaterial(this.material, options);
		this.material.drawMode = t3d.DRAW_MODE.POINTS;

		this.uniforms = this.material.uniforms;
		this.defines = this.material.defines;

		// Create the BufferGeometry and Points instances, ensuring
		// the geometry and material are given to the latter.

		this.geometry = new t3d.Geometry();
		this.geometry.addGroup(0, this.particleCount, 0);
		this.mesh = new t3d.Mesh(this.geometry, [this.material]);
		this.mesh.frustumCulled = false;

		// Map of all attributes to be applied to the particles.
		//
		// See ShaderAttribute for a bit more info on this bit.
		this.attributes = {
			position: new ShaderAttribute('v3', true),
			acceleration: new ShaderAttribute('v4', true), // w component is drag
			velocity: new ShaderAttribute('v3', true),
			rotation: new ShaderAttribute('v4', true),
			rotationCenter: new ShaderAttribute('v3', true),
			params: new ShaderAttribute('v4', true), // Holds (alive, age, delay, wiggle)
			size: new ShaderAttribute('v4', true),
			angle: new ShaderAttribute('v4', true),
			color: new ShaderAttribute('v4', true),
			opacity: new ShaderAttribute('v4', true)
		};

		this.attributeKeys = Object.keys(this.attributes);
		this.attributeCount = this.attributeKeys.length;

		// Whether all attributes should be forced to updated
		// their entire buffer contents on the next tick.
		//
		// Used when an emitter is removed.
		this._attributesNeedRefresh = false;
		this._attributesNeedDynamicReset = false;

		//

		this.particleCount = 0;
	}

	/**
	 * Adds an ParticleEmitter instance to this group, creating particle values and
	 * assigning them to this group's shader attributes.
	 *
	 * @param {ParticleEmitter} emitter The emitter to add to this group.
	 */
	addEmitter(emitter) {
		// Ensure an actual emitter instance is passed here.
		//
		// Decided not to throw here, just in case a scene's
		// rendering would be paused. Logging an error instead
		// of stopping execution if exceptions aren't caught.
		if (emitter instanceof ParticleEmitter === false) {
			console.error('`emitter` argument must be instance of ParticleEmitter. Was provided with:', emitter);
			return;
		} else if (this._emitters.indexOf(emitter) > -1) {
			// If the emitter already exists as a member of this group, then
			// stop here, we don't want to add it again.
			console.error('ParticleEmitter already exists in this group. Will not add again.');
			return;
		} else if (emitter.group !== null) {
			// And finally, if the emitter is a member of another group,
			// don't add it to this group.
			console.error('ParticleEmitter already belongs to another group. Will not add to requested group.');
			return;
		}

		let attributes = this.attributes,
			start = this.particleCount,
			end = start + emitter.particleCount;

		// Update this group's particle count.
		this.particleCount = end;

		// Emit a warning if the emitter being added will exceed the buffer sizes specified.
		if (this.maxParticleCount !== null && this.particleCount > this.maxParticleCount) {
			console.warn('ParticleGroup: maxParticleCount exceeded. Requesting', this.particleCount, 'particles, can support only', this.maxParticleCount);
		}

		// Set the `particlesPerSecond` value (PPS) on the emitter.
		// It's used to determine how many particles to release
		// on a per-frame basis.
		// emitter.calculatePPSValue();
		emitter._setBufferUpdateRanges(this.attributeKeys);

		// Store the offset value in the TypedArray attributes for this emitter.
		emitter._setAttributeOffset(start);

		// Save a reference to this group on the emitter so it knows
		// where it belongs.
		emitter.group = this;

		// Store reference to the attributes on the emitter for
		// easier access during the emitter's tick function.
		emitter.attributes = this.attributes;

		// Ensure the attributes and their BufferAttributes exist, and their
		// TypedArrays are of the correct size.
		for (const attr in attributes) {
			if (attributes.hasOwnProperty(attr)) {
				// When creating a buffer, pass through the maxParticle count
				// if one is specified.
				attributes[attr]._createBufferAttribute(
					this.maxParticleCount !== null ?
						this.maxParticleCount :
						this.particleCount
				);
			}
		}

		// Loop through each particle this emitter wants to have, and create the attributes values,
		// storing them in the TypedArrays that each attribute holds.
		for (let i = start; i < end; ++i) {
			emitter._assignValue('position', i);
			emitter._assignValue('velocity', i);
			emitter._assignValue('acceleration', i);
			emitter._assignValue('size', i);
			emitter._assignValue('opacity', i);
			emitter._assignValue('angle', i);
			emitter._assignValue('params', i);
			emitter._assignValue('rotation', i);
			emitter._assignValue('color', i);
		}

		// Update the geometry and make sure the attributes are referencing
		// the typed arrays properly.
		this._applyAttributesToGeometry();

		// Store this emitter in this group's emitter's store.
		this._emitters.push(emitter);

		// Update certain flags to enable shader calculations only if they're necessary.
		this.$updateDefines(emitter);

		this._attributesNeedRefresh = true;

		// Return the group to enable chaining.
		return this;
	}

	/**
	 * Removes an ParticleEmitter instance from this group. When called,
	 * all particle's belonging to the given emitter will be instantly
	 * removed from the scene.
	 *
	 * @param {ParticleEmitter} emitter The emitter to add to this group.
	 */
	removeEmitter(emitter) {
		const emitterIndex = this._emitters.indexOf(emitter);

		// Ensure an actual emitter instance is passed here.
		//
		// Decided not to throw here, just in case a scene's
		// rendering would be paused. Logging an error instead
		// of stopping execution if exceptions aren't caught.
		if (emitter instanceof ParticleEmitter === false) {
			console.error('`emitter` argument must be instance of ParticleEmitter. Was provided with:', emitter);
			return;
		} else if (emitterIndex === -1) {
			// Issue an error if the emitter isn't a member of this group.
			console.error('ParticleEmitter does not exist in this group. Will not remove.');
			return;
		}

		// Kill all particles by marking them as dead
		// and their age as 0.
		const start = emitter.attributeOffset,
			end = start + emitter.particleCount,
			params = this.attributes.params.typedArray;

		// Set alive and age to zero.
		for (let i = start; i < end; ++i) {
			params.array[i * 4] = 0.0;
			params.array[i * 4 + 1] = 0.0;
		}

		// Remove the emitter from this group's "store".
		this._emitters.splice(emitterIndex, 1);

		// Remove this emitter's attribute values from all shader attributes.
		// The `.splice()` call here also marks each attribute's buffer
		// as needing to update it's entire contents.
		for (const attr in this.attributes) {
			if (this.attributes.hasOwnProperty(attr)) {
				this.attributes[attr].splice(start, end);
			}
		}

		// Ensure this group's particle count is correct.
		this.particleCount -= emitter.particleCount;

		// Call the emitter's remove method.
		emitter._onRemove();

		// Set a flag to indicate that the attribute buffers should
		// be updated in their entirety on the next frame.
		this._attributesNeedRefresh = true;
	}

	/**
	 * Simulate all the emitter's belonging to this group, updating
	 * attribute values along the way.
	 * @param  {Number} [dt=Group's `fixedTimeStep` value] The number of seconds to simulate the group's emitters for (deltaTime)
	 */
	tick(dt) {
		const emitters = this._emitters,
			numEmitters = emitters.length,
			deltaTime = dt || this.fixedTimeStep,
			keys = this.attributeKeys,
			attrs = this.attributes;

		let i, j;

		// Update uniform values.

		this.uniforms.runTime += deltaTime;
		this.uniforms.deltaTime = deltaTime;

		// Reset buffer update ranges on the shader attributes.

		i = this.attributeCount - 1;

		for (i; i >= 0; --i) {
			attrs[keys[i]].resetUpdateRange();
		}

		// If nothing needs updating, then stop here.

		if (
			numEmitters === 0 &&
			this._attributesNeedRefresh === false &&
			this._attributesNeedDynamicReset === false
		) {
			return;
		}

		// Loop through each emitter in this group and
		// simulate it, then update the shader attribute
		// buffers.

		for (j = 0; j < numEmitters; ++j) {
			const emitter = emitters[j];

			// Run tick

			emitter.tick(deltaTime);

			// Mark update range

			const emitterRanges = emitter.bufferUpdateRanges;

			let key,
				emitterAttr,
				attr;

			i = this.attributeCount - 1;

			for (i; i >= 0; --i) {
				key = keys[i];
				emitterAttr = emitterRanges[key];
				attr = attrs[key];
				attr.setUpdateRange(emitterAttr.min, emitterAttr.max);
				attr.flagUpdate();
			}
		}

		// If the shader attributes have been refreshed,
		// then the dynamic properties of each buffer
		// attribute will need to be reset back to
		// what they should be.

		if (this._attributesNeedDynamicReset === true) {
			i = this.attributeCount - 1;

			for (i; i >= 0; --i) {
				attrs[keys[i]].resetDynamic();
			}

			this._attributesNeedDynamicReset = false;
		}

		// If this group's shader attributes need a full refresh
		// then mark each attribute's buffer attribute as
		// needing so.

		if (this._attributesNeedRefresh === true) {
			i = this.attributeCount - 1;

			for (i; i >= 0; --i) {
				attrs[keys[i]].forceUpdateAll();
			}

			this._attributesNeedRefresh = false;
			this._attributesNeedDynamicReset = true;
		}
	}

	/**
	 * Dipose the geometry and material for the group.
	 *
	 * @return {ParticleGroup} ParticleGroup instance.
	 */
	dispose() {
		this.mesh.geometry.dispose();
		this.mesh.material[0].dispose();

		// TODO remove all emitters?

		return this;
	}

	$updateDefines() {
		const emitters = this._emitters,
			defines = this.defines;

		let i = emitters.length - 1, emitter;

		for (i; i >= 0; --i) {
			emitter = emitters[i];

			// Only do angle calculation if there's no spritesheet defined.
			//
			// Saves calculations being done and then overwritten in the shaders.
			if (!defines.SHOULD_CALCULATE_SPRITE) {
				defines.SHOULD_ROTATE_TEXTURE = defines.SHOULD_ROTATE_TEXTURE || !!Math.max(
					Math.max.apply(null, emitter.angle.value),
					Math.max.apply(null, emitter.angle.spread)
				);
			}

			defines.SHOULD_ROTATE_PARTICLES = defines.SHOULD_ROTATE_PARTICLES || !!Math.max(
				emitter.rotation.angle,
				emitter.rotation.angleSpread
			);

			defines.SHOULD_WIGGLE_PARTICLES = defines.SHOULD_WIGGLE_PARTICLES || !!Math.max(
				emitter.wiggle.value,
				emitter.wiggle.spread
			);
		}

		// Update the material since defines might have changed
		this.material.needsUpdate = true;
	}

	_applyAttributesToGeometry() {
		const attributes = this.attributes,
			geometry = this.geometry,
			geometryAttributes = geometry.attributes;

		let attribute, geometryAttribute;

		// Loop through all the shader attributes and assign (or re-assign)
		// typed array buffers to each one.
		for (const attr in attributes) {
			if (attributes.hasOwnProperty(attr)) {
				attribute = attributes[attr];
				geometryAttribute = geometryAttributes[attr === 'position' ? 'a_Position' : attr];

				// Update the array if this attribute exists on the geometry.
				//
				// This needs to be done because the attribute's typed array might have
				// been resized and reinstantiated, and might now be looking at a
				// different ArrayBuffer, so reference needs updating.
				if (geometryAttribute) {
					// TODO change the buffer ?
				} else {
					// Add the attribute to the geometry if it doesn't already exist.
					geometry.addAttribute(
						attr === 'position' ? 'a_Position' : attr,
						attribute.bufferAttribute
					);
				}
			}
		}

		this.geometry.version++;

		// Mark the draw range on the geometry. This will ensure
		// only the values in the attribute buffers that are
		// associated with a particle will be used in t3d's
		// render cycle.
		this.geometry.groups[0].count = this.particleCount;
	}

}