'use strict';
/**
 * A small JSON Schema validator (Compute plan E7): the actions of the catalogue carry a JSON Schema for
 * their input, and the gateway checks the input against it before anything leaves the building.
 *
 * The supported keywords are the ones an action actually needs:
 *
 *   type (a name or a list of names), properties, required, additionalProperties (false or a schema),
 *   enum, const, items, minItems, maxItems, uniqueItems, minimum, maximum, exclusiveMinimum,
 *   exclusiveMaximum, multipleOf, minLength, maxLength, pattern, allOf, anyOf, oneOf, not
 *
 * Anything else in a schema is ignored, so an action cannot widen itself by naming a keyword this
 * validator does not know: an unknown keyword never loosens a check. A schema that is not an object,
 * or a property whose schema is not an object, is a mistake in the definition and is refused.
 *
 *   validate(schema, value)  -> { valid: true } | { valid: false, errors: [{ path, message }] }
 */
const MAX_DEPTH = 12;
const MAX_ERRORS = 20;

const TYPE_OF = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (Number.isInteger(v)) return 'integer';
    if (typeof v === 'number') return 'number';
    return typeof v;   // string | boolean | object
};

const typeMatches = (v, name) => {
    const actual = TYPE_OF(v);
    if (name === 'number') return actual === 'number' || actual === 'integer';
    return actual === name;
};

function check(schema, value, path, errors, depth) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        errors.push({ path, message: 'the schema for this field is not an object' });
        return;
    }
    if (depth > MAX_DEPTH) { errors.push({ path, message: 'the input is nested too deeply' }); return; }

    if (schema.type !== undefined) {
        const names = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!names.some((n) => typeMatches(value, n))) {
            errors.push({ path, message: `must be ${names.join(' or ')}` });
            return;
        }
    }
    if (schema.enum !== undefined && Array.isArray(schema.enum)) {
        if (!schema.enum.some((e) => e === value)) errors.push({ path, message: 'must be one of the allowed values' });
    }
    if (schema.const !== undefined && value !== schema.const) {
        errors.push({ path, message: 'must be the one allowed value' });
    }
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push({ path, message: `must be at least ${schema.minimum}` });
        if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push({ path, message: `must be at most ${schema.maximum}` });
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push({ path, message: `must be more than ${schema.exclusiveMinimum}` });
        if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) errors.push({ path, message: `must be less than ${schema.exclusiveMaximum}` });
        if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
            const q = value / schema.multipleOf;
            if (Math.abs(q - Math.round(q)) > 1e-9) errors.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
        }
    }
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push({ path, message: `must be at least ${schema.minLength} characters` });
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
        if (typeof schema.pattern === 'string') {
            let re = null;
            try { re = new RegExp(schema.pattern); } catch { re = null; }
            if (re && !re.test(value)) errors.push({ path, message: 'has the wrong shape' });
        }
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push({ path, message: `must have at least ${schema.minItems} items` });
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push({ path, message: `must have at most ${schema.maxItems} items` });
        if (schema.uniqueItems === true) {
            const seen = new Set(value.map((v) => JSON.stringify(v)));
            if (seen.size !== value.length) errors.push({ path, message: 'must not repeat an item' });
        }
        if (schema.items && typeof schema.items === 'object') {
            value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors, depth + 1));
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        for (const name of Array.isArray(schema.required) ? schema.required : []) {
            if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push({ path: `${path}.${name}`, message: 'is required' });
        }
        for (const [name, child] of Object.entries(value)) {
            if (Object.prototype.hasOwnProperty.call(props, name)) {
                check(props[name], child, `${path}.${name}`, errors, depth + 1);
            } else if (schema.additionalProperties === false) {
                errors.push({ path: `${path}.${name}`, message: 'is not an allowed field' });
            } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                check(schema.additionalProperties, child, `${path}.${name}`, errors, depth + 1);
            }
        }
    }
    if (Array.isArray(schema.allOf)) {
        for (const sub of schema.allOf) check(sub, value, path, errors, depth + 1);
    }
    if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
        const ok = schema.anyOf.some((sub) => {
            const local = [];
            check(sub, value, path, local, depth + 1);
            return local.length === 0;
        });
        if (!ok) errors.push({ path, message: 'does not match any of the allowed shapes' });
    }
    if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
        let hits = 0;
        for (const sub of schema.oneOf) {
            const local = [];
            check(sub, value, path, local, depth + 1);
            if (!local.length) hits += 1;
        }
        if (hits !== 1) errors.push({ path, message: 'must match exactly one of the allowed shapes' });
    }
    if (schema.not && typeof schema.not === 'object') {
        const local = [];
        check(schema.not, value, path, local, depth + 1);
        if (!local.length) errors.push({ path, message: 'must not match the excluded shape' });
    }
}

/** The result of one check: { valid: true } or { valid: false, errors: [{ path, message }] }. */
function validate(schema, value) {
    const errors = [];
    try {
        check(schema, value, '', errors, 0);
    } catch (e) {
        errors.push({ path: '', message: `the schema could not be applied: ${e.message}` });
    }
    if (!errors.length) return { valid: true };
    return { valid: false, errors: errors.slice(0, MAX_ERRORS) };
}

/** The errors as one short line, for an error message. */
const describe = (result) => result.errors.map((e) => `${e.path || 'input'} ${e.message}`).join('; ').slice(0, 300);

module.exports = { validate, describe };
