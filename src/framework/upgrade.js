import assert from "./assert.js";
import { patch } from "./patcher.js";
import { setAttribute, removeAttribute } from "./attributes.js";
import { getComponentDef } from "./def.js";
import { createComponent } from "./vm.js";
import { v } from "./api.js";
import { loaderImportMethod } from "./loader.js";

const fakeElement = document.createElement('raptor'); // fake element to patch and resolve vm.elm
const Ep = Element.prototype;

function linkAttributes(element: HTMLElement, vm: VM) {
    assert.vm(vm);
    const { Ctor } = vm;
    let { attrs } = getComponentDef(Ctor);
    // replacing mutators on the element itself to catch any mutation
    element.setAttribute = (attrName: string, value: any) => {
        Ep.setAttribute.call(element, attrName, value);
        if (attrs.hasOwnProperty(attrName)) {
            setAttribute(vm, attrName, value);
        }
    };
    element.removeAttribute = (attrName: string) => {
        Ep.removeAttribute.call(element, attrName);
        if (attrs.hasOwnProperty(attrName)) {
            removeAttribute(vm, attrName);
        }
    };
    assert.block(() => {
        // this is to warn in dev mode when they try to do an invalid mutation on an element.
        const observer = new MutationObserver((mutations: Array<MutationRecord>) => {
            mutations.forEach((mutation: MutationRecord) => {
                console.error(`Arbitrary mutations in a child element of the Raptor Element <${element.tagName}> can have unpredictable results. Instead, you can use setAttribute() and removeAttribute() on the Raptor Element to mutate its state.`);
            });
        });
        const config: MutationObserverInit = {
            childList: true,
        };
        observer.observe(element, config);
    });
}

function linkProperties(element: HTMLElement, vm: VM) {
    assert.vm(vm);
    const { Ctor, component } = vm;
    let { props, methods } = getComponentDef(Ctor);
    const descriptors: PropertyDescriptorMap = {};
    // linking public methods
    for (let methodName in methods) {
        descriptors[methodName] = {
            value: function (): any {
                return component[methodName](...arguments);
            },
            configurable: false,
            writable: false,
            enumerable: false,
        };
    }
    // linking reflective properties
    for (let propName in props) {
        descriptors[propName] = {
            get: (): any => component[propName],
            configurable: false,
            enumerable: true,
        };
        assert.block(() => {
            descriptors[propName].set = () => {
                const { attrName } = props[propName];
                throw new Error(`Invalid mutation of Raptor Element via property setter: <${element.tagName}>.${propName}. Instead use setAttribute("${attrName}", ...) or removeAttribute("${attrName}").`);
            };
        });
    }
    Object.defineProperties(element, descriptors);
}

function createVM(element: HTMLElement, Ctor: any, props: HashTable<any>): VM {
    const tagName = element.tagName.toLowerCase();
    let vm = v(Ctor, { props });
    createComponent(vm);
    if (vm.sel !== element.tagName) {
        // forcing the vm.sel to match the source element tagName otherwise it may be replaced when patching it.
        vm.sel = tagName;
        assert.block(() => {
            console.warn(`Raptor Component ${vm} is normally used for <${Ctor.tagName}> elements instead of <${tagName}>.`);
        });
    }
    if (vm.flags.hasElement) {
        vm = patch(element, vm);
    } else {
        /**
         * Snabdom does not have a way to process the vnode to produce an element, instead we need to
         * patch the vnode against some fake html element, then we can inspect the element. More here:
         * https://github.com/snabbdom/snabbdom/issues/156
         */
        vm = patch(fakeElement.cloneNode(), vm);
        element.appendChild(vm.elm);
    }
    return vm;
}

/**
 * This algo mimics 2.5 of web component specification somehow:
 * https://www.w3.org/TR/custom-elements/#upgrades
 */
function upgradeElement(element: HTMLElement, Ctor: ObjectConstructor, domAttrs: HashTable<any>): Component {
    if (!Ctor) {
        throw new TypeError(`Invalid Raptor Component Definition: ${Ctor}.`);
    }
    const { attrs } = getComponentDef(Ctor);
    const props = {};
    for (let attrName in attrs) {
        if (attrName in domAttrs) {
            props[attrs[attrName].propName] = domAttrs[attrName];
        }
    }
    const vm = createVM(element, Ctor, props);
    linkAttributes(element, vm);
    // TODO: for vm with element we might not need to do any of these.
    linkProperties(element, vm);
    return vm.component;
}

function upgrade(element: HTMLElement, CtorOrPromise: Promise<ObjectConstructor> | ObjectConstructor): Promise<HTMLElement> {
    return new Promise((resolve: (element: HTMLElement) => void, reject: (e: Error) => void) => {
        assert.isTrue(element instanceof HTMLElement, `upgrade() first argument should be a DOM Element instead of ${element}.`);
        const domAttrs = {};
        const p = Promise.resolve(CtorOrPromise);
        // temporarily replacing mutators on the element itself to catch any mutation
        // while waiting for the Ctor to be ready to upgrade the element. This guarantees
        // that any attribute mutation after upgrade() is called is consistent, even when
        // the element hasn't been fully upgraded.
        element.setAttribute = (attrName: string, value: any) => {
            domAttrs[attrName] = value;
            Ep.setAttribute.call(element, attrName, value);
        };
        element.removeAttribute = (attrName: string) => {
            domAttrs[attrName] = null;
            Ep.removeAttribute.call(element, attrName);
        };
        p.then((Ctor: ObjectConstructor) => {
            upgradeElement(element, Ctor, domAttrs);
            resolve(element);
        }, reject);
    });
}

const definedElements = {};
const createElementOriginal = document.createElement;

export function createElement(tagName: string): HTMLElement {
    const element = createElementOriginal.call(this, ...arguments);
    if (!tagName || tagName in definedElements || tagName.indexOf('-') === -1 || !(element instanceof HTMLElement)) {
        return element;
    }
    // it must be a raptor element, lets derivate the namespace from tagName,
    // where only the first `-` should be replaced
    const moduleName = element.tagName.toLowerCase().replace('-', ':');
    // TODO: maybe a local hash of resolved modules to speed things up.
    upgrade(element, loaderImportMethod(moduleName)).catch((e: Error) => {
        console.error(`Error trying to upgrade element <${element.tagName.toLowerCase()}>. ${e}`);
    });
    return element;
}

try {
    document.createElement = createElement;
} catch (e) {
    console.warn(`document.createElement cannot be redefined. ${e}`);
}

try {
    if (typeof customElements !== undefined && customElements.define) {
        const defineOriginal = customElements.define;
        customElements.define = function (tagName: string) {
            defineOriginal.call(this, ...arguments);
            definedElements[tagName] = undefined;
        }
    }
} catch (e) {
    console.warn(`customElements.define cannot be redefined. ${e}`);
}
