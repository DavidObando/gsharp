// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"fmt"
	"go/types"
	"sort"
	"strconv"
	"strings"
)

func canonicalType(t types.Type) string {
	if t == nil {
		return ""
	}
	return types.TypeString(t, func(pkg *types.Package) string {
		if pkg == nil {
			return ""
		}
		return pkg.Path()
	})
}

func canonicalTypeIdentity(t types.Type) string {
	return canonicalTypeIdentityWith(t, typeObjectIdentity)
}

func canonicalTypeIdentityWith(t types.Type, identify func(*types.TypeName) string) string {
	if t == nil {
		return ""
	}
	if _, basic := t.(*types.Basic); basic {
		return canonicalType(t)
	}
	builder := typeIdentityGraphBuilder{
		identify: identify,
		nodes:    []typeIdentityNode{},
		nodeIDs:  map[typeIdentityKey]int{},
		active:   map[types.Type]int{},
	}
	root := builder.reference(t, nil)
	classes, classKeys, representatives := canonicalTypeIdentityClasses(builder.nodes)
	serializer := typeIdentityGraphSerializer{
		nodes: builder.nodes, classes: classes, classKeys: classKeys,
		representatives: representatives, ids: map[int]int{},
	}
	rootReference := serializer.reference(classes[root])
	var result strings.Builder
	result.WriteString("root=")
	result.WriteString(rootReference)
	for id, definition := range serializer.output {
		result.WriteString(";@")
		result.WriteString(strconv.Itoa(id))
		result.WriteByte('=')
		result.WriteString(definition)
	}
	return result.String()
}

type typeIdentityKey struct {
	t     types.Type
	scope *typeIdentityBinderScope
}

type typeIdentityBinderBinding struct {
	owner   int
	kind    string
	index   int
	node    int
	hasNode bool
}

type typeIdentityBinderScope struct {
	parent   *typeIdentityBinderScope
	bindings map[*types.TypeParam]*typeIdentityBinderBinding
}

func (s *typeIdentityBinderScope) lookup(parameter *types.TypeParam) (*typeIdentityBinderBinding, bool) {
	for current := s; current != nil; current = current.parent {
		if binding, ok := current.bindings[parameter]; ok {
			return binding, true
		}
	}
	return nil, false
}

type typeIdentityMember struct {
	prefix string
	suffix string
	target int
}

type typeIdentityGroup struct {
	name      string
	list      bool
	unordered bool
	members   []typeIdentityMember
}

type typeIdentityNode struct {
	kind   string
	values []string
	groups []typeIdentityGroup
}

type typeIdentityGraphBuilder struct {
	identify func(*types.TypeName) string
	nodes    []typeIdentityNode
	nodeIDs  map[typeIdentityKey]int
	active   map[types.Type]int
}

func (b *typeIdentityGraphBuilder) reference(t types.Type, scope *typeIdentityBinderScope) int {
	if t == nil {
		return -1
	}
	if parameter, ok := t.(*types.TypeParam); ok {
		if binding, bound := scope.lookup(parameter); bound {
			return b.boundReference(binding)
		}
	}
	if id, ok := b.active[t]; ok {
		return id
	}
	key := typeIdentityKey{t: t, scope: scope}
	if id, ok := b.nodeIDs[key]; ok {
		return id
	}
	id := len(b.nodes)
	b.nodeIDs[key] = id
	b.nodes = append(b.nodes, typeIdentityNode{})
	b.active[t] = id
	b.nodes[id] = b.definition(id, t, scope)
	delete(b.active, t)
	return id
}

func (b *typeIdentityGraphBuilder) boundReference(binding *typeIdentityBinderBinding) int {
	if binding.hasNode {
		return binding.node
	}
	binding.node = len(b.nodes)
	binding.hasNode = true
	b.nodes = append(b.nodes, typeIdentityNode{
		kind: "boundTypeParameter",
		values: []string{
			"kind=" + binding.kind,
			"index=" + strconv.Itoa(binding.index),
		},
		groups: []typeIdentityGroup{typeIdentitySingle("owner", binding.owner)},
	})
	return binding.node
}

func typeIdentitySingle(name string, target int) typeIdentityGroup {
	return typeIdentityGroup{name: name, members: []typeIdentityMember{{target: target}}}
}

func typeIdentityList(name string, unordered bool, members []typeIdentityMember) typeIdentityGroup {
	return typeIdentityGroup{name: name, list: true, unordered: unordered, members: members}
}

func (b *typeIdentityGraphBuilder) definition(
	id int,
	t types.Type,
	scope *typeIdentityBinderScope,
) typeIdentityNode {
	switch value := t.(type) {
	case *types.Alias:
		return typeIdentityNode{
			kind:   "alias",
			values: []string{"declaration=" + strconv.Quote(b.identify(value.Obj()))},
			groups: []typeIdentityGroup{
				typeIdentityList("arguments", false, b.typeList(value.TypeArgs(), scope)),
				typeIdentitySingle("underlying", b.reference(value.Underlying(), scope)),
			},
		}
	case *types.Array:
		return typeIdentityNode{
			kind:   "array",
			values: []string{"length=" + strconv.FormatInt(value.Len(), 10)},
			groups: []typeIdentityGroup{typeIdentitySingle("element", b.reference(value.Elem(), scope))},
		}
	case *types.Basic:
		return typeIdentityNode{kind: "basic", values: []string{strconv.Quote(canonicalType(value))}}
	case *types.Chan:
		return typeIdentityNode{
			kind:   "channel",
			values: []string{"direction=" + strconv.Itoa(int(value.Dir()))},
			groups: []typeIdentityGroup{typeIdentitySingle("element", b.reference(value.Elem(), scope))},
		}
	case *types.Interface:
		value.Complete()
		var methods []typeIdentityMember
		for i := 0; i < value.NumMethods(); i++ {
			method := value.Method(i)
			owner := ""
			if !method.Exported() && method.Pkg() != nil {
				owner = method.Pkg().Path()
			}
			methods = append(methods, typeIdentityMember{
				prefix: "method(name=" + strconv.Quote(method.Name()) +
					",owner=" + strconv.Quote(owner) + ",type=",
				suffix: ")",
				target: b.reference(method.Type(), scope),
			})
		}
		var embedded []typeIdentityMember
		for i := 0; i < value.NumEmbeddeds(); i++ {
			embedded = append(embedded, typeIdentityMember{
				target: b.reference(value.EmbeddedType(i), scope),
			})
		}
		return typeIdentityNode{
			kind: "interface",
			groups: []typeIdentityGroup{
				typeIdentityList("methods", true, methods),
				typeIdentityList("embedded", true, embedded),
			},
		}
	case *types.Map:
		return typeIdentityNode{
			kind: "map",
			groups: []typeIdentityGroup{
				typeIdentitySingle("key", b.reference(value.Key(), scope)),
				typeIdentitySingle("element", b.reference(value.Elem(), scope)),
			},
		}
	case *types.Named:
		return typeIdentityNode{
			kind:   "named",
			values: []string{"declaration=" + strconv.Quote(b.identify(value.Obj()))},
			groups: []typeIdentityGroup{
				typeIdentityList("arguments", false, b.typeList(value.TypeArgs(), scope)),
				typeIdentitySingle("underlying", b.reference(value.Underlying(), scope)),
			},
		}
	case *types.Pointer:
		return typeIdentityNode{
			kind:   "pointer",
			groups: []typeIdentityGroup{typeIdentitySingle("element", b.reference(value.Elem(), scope))},
		}
	case *types.Signature:
		signatureScope := b.signatureScope(id, value, scope)
		// Go signature identity ignores the receiver. Receiver type parameters remain bound when parameters or results reference them.
		return typeIdentityNode{
			kind:   "signature",
			values: []string{"variadic=" + strconv.FormatBool(value.Variadic())},
			groups: []typeIdentityGroup{
				typeIdentityList("typeParameters", false,
					b.typeParameterConstraints(value.TypeParams(), signatureScope)),
				typeIdentitySingle("parameters", b.reference(value.Params(), signatureScope)),
				typeIdentitySingle("results", b.reference(value.Results(), signatureScope)),
			},
		}
	case *types.Slice:
		return typeIdentityNode{
			kind:   "slice",
			groups: []typeIdentityGroup{typeIdentitySingle("element", b.reference(value.Elem(), scope))},
		}
	case *types.Struct:
		var fields []typeIdentityMember
		for i := 0; i < value.NumFields(); i++ {
			field := value.Field(i)
			owner := ""
			if !field.Exported() && field.Pkg() != nil {
				owner = field.Pkg().Path()
			}
			fields = append(fields, typeIdentityMember{
				prefix: "field(name=" + strconv.Quote(field.Name()) +
					",owner=" + strconv.Quote(owner) +
					",embedded=" + strconv.FormatBool(field.Embedded()) +
					",tag=" + strconv.Quote(value.Tag(i)) +
					",type=",
				suffix: ")",
				target: b.reference(field.Type(), scope),
			})
		}
		return typeIdentityNode{
			kind:   "struct",
			groups: []typeIdentityGroup{typeIdentityList("fields", false, fields)},
		}
	case *types.Tuple:
		var elements []typeIdentityMember
		for i := 0; i < value.Len(); i++ {
			elements = append(elements, typeIdentityMember{
				target: b.reference(value.At(i).Type(), scope),
			})
		}
		return typeIdentityNode{
			kind:   "tuple",
			groups: []typeIdentityGroup{typeIdentityList("elements", false, elements)},
		}
	case *types.TypeParam:
		return typeIdentityNode{
			kind:   "freeTypeParameter",
			values: []string{"declaration=" + strconv.Quote(b.identify(value.Obj()))},
			groups: []typeIdentityGroup{
				typeIdentitySingle("constraint", b.reference(value.Constraint(), scope)),
			},
		}
	case *types.Union:
		var terms []typeIdentityMember
		for i := 0; i < value.Len(); i++ {
			term := value.Term(i)
			terms = append(terms, typeIdentityMember{
				prefix: "term(tilde=" + strconv.FormatBool(term.Tilde()) + ",type=",
				suffix: ")",
				target: b.reference(term.Type(), scope),
			})
		}
		return typeIdentityNode{
			kind:   "union",
			groups: []typeIdentityGroup{typeIdentityList("terms", true, terms)},
		}
	default:
		return typeIdentityNode{
			kind:   "unknown",
			values: []string{"display=" + strconv.Quote(canonicalType(t))},
		}
	}
}

func (b *typeIdentityGraphBuilder) signatureScope(
	id int,
	signature *types.Signature,
	parent *typeIdentityBinderScope,
) *typeIdentityBinderScope {
	scope := &typeIdentityBinderScope{
		parent:   parent,
		bindings: map[*types.TypeParam]*typeIdentityBinderBinding{},
	}
	if parameters := signature.RecvTypeParams(); parameters != nil {
		for i := 0; i < parameters.Len(); i++ {
			scope.bindings[parameters.At(i)] = &typeIdentityBinderBinding{
				owner: id, kind: "receiver", index: i,
			}
		}
	}
	if parameters := signature.TypeParams(); parameters != nil {
		for i := 0; i < parameters.Len(); i++ {
			scope.bindings[parameters.At(i)] = &typeIdentityBinderBinding{
				owner: id, kind: "type", index: i,
			}
		}
	}
	return scope
}

func (b *typeIdentityGraphBuilder) typeList(
	types *types.TypeList,
	scope *typeIdentityBinderScope,
) []typeIdentityMember {
	if types == nil {
		return nil
	}
	values := make([]typeIdentityMember, types.Len())
	for i := 0; i < types.Len(); i++ {
		values[i].target = b.reference(types.At(i), scope)
	}
	return values
}

func (b *typeIdentityGraphBuilder) typeParameterConstraints(
	parameters *types.TypeParamList,
	scope *typeIdentityBinderScope,
) []typeIdentityMember {
	if parameters == nil {
		return nil
	}
	values := make([]typeIdentityMember, parameters.Len())
	for i := 0; i < parameters.Len(); i++ {
		values[i].target = b.reference(parameters.At(i).Constraint(), scope)
	}
	return values
}

func canonicalTypeIdentityClasses(
	nodes []typeIdentityNode,
) (classes []int, classKeys []string, representatives []int) {
	// Refine node classes until each class has one structural definition.
	// This hash-conses equal DAG nodes and preserves recursive edges without using allocation identity.
	classes = make([]int, len(nodes))
	for {
		keys := make([]string, len(nodes))
		maxClass := 0
		for i, node := range nodes {
			keys[i] = typeIdentityNodeKey(node, classes)
			if classes[i] > maxClass {
				maxClass = classes[i]
			}
		}
		keysByClass := make([][]string, maxClass+1)
		for i, key := range keys {
			keysByClass[classes[i]] = append(keysByClass[classes[i]], key)
		}
		classByOldKey := make([]map[string]int, len(keysByClass))
		classKeys = classKeys[:0]
		for oldClass, oldKeys := range keysByClass {
			sort.Strings(oldKeys)
			classByOldKey[oldClass] = map[string]int{}
			for _, key := range oldKeys {
				if _, exists := classByOldKey[oldClass][key]; exists {
					continue
				}
				classByOldKey[oldClass][key] = len(classKeys)
				classKeys = append(classKeys, key)
			}
		}
		next := make([]int, len(nodes))
		same := true
		for i, key := range keys {
			next[i] = classByOldKey[classes[i]][key]
			if next[i] != classes[i] {
				same = false
			}
		}
		classes = next
		if same {
			break
		}
	}
	representatives = make([]int, len(classKeys))
	for i := range representatives {
		representatives[i] = -1
	}
	for node, class := range classes {
		if representatives[class] < 0 {
			representatives[class] = node
		}
	}
	return classes, classKeys, representatives
}

func typeIdentityNodeKey(node typeIdentityNode, classes []int) string {
	var result strings.Builder
	result.WriteString(node.kind)
	for _, value := range node.values {
		result.WriteString("|v:")
		result.WriteString(strconv.Quote(value))
	}
	for _, group := range node.groups {
		result.WriteString("|g:")
		result.WriteString(strconv.Quote(group.name))
		if group.list {
			result.WriteByte('l')
		}
		if group.unordered {
			result.WriteByte('u')
		}
		members := typeIdentityMemberKeys(group, classes)
		for _, member := range members {
			result.WriteString("|m:")
			result.WriteString(member)
		}
	}
	return result.String()
}

func typeIdentityMemberKeys(group typeIdentityGroup, classes []int) []string {
	members := make([]string, len(group.members))
	for i, member := range group.members {
		class := -1
		if member.target >= 0 {
			class = classes[member.target]
		}
		members[i] = strconv.Quote(member.prefix) + ":" + strconv.Itoa(class) +
			":" + strconv.Quote(member.suffix)
	}
	if group.unordered {
		sort.Strings(members)
	}
	return members
}

type typeIdentityGraphSerializer struct {
	nodes           []typeIdentityNode
	classes         []int
	classKeys       []string
	representatives []int
	ids             map[int]int
	output          []string
}

func (s *typeIdentityGraphSerializer) reference(class int) string {
	if class < 0 {
		return "nil"
	}
	if id, ok := s.ids[class]; ok {
		return "@" + strconv.Itoa(id)
	}
	id := len(s.output)
	s.ids[class] = id
	s.output = append(s.output, "")
	s.output[id] = s.definition(s.nodes[s.representatives[class]])
	return "@" + strconv.Itoa(id)
}

func (s *typeIdentityGraphSerializer) definition(node typeIdentityNode) string {
	parts := append([]string{}, node.values...)
	for _, group := range node.groups {
		members := append([]typeIdentityMember{}, group.members...)
		if group.unordered {
			sort.SliceStable(members, func(i, j int) bool {
				return s.memberKey(members[i]) < s.memberKey(members[j])
			})
		}
		rendered := make([]string, len(members))
		for i, member := range members {
			class := -1
			if member.target >= 0 {
				class = s.classes[member.target]
			}
			rendered[i] = member.prefix + s.reference(class) + member.suffix
		}
		value := "nil"
		if group.list {
			value = "[" + strings.Join(rendered, ",") + "]"
		} else if len(rendered) == 1 {
			value = rendered[0]
		}
		parts = append(parts, group.name+"="+value)
	}
	return node.kind + "(" + strings.Join(parts, ",") + ")"
}

func (s *typeIdentityGraphSerializer) memberKey(member typeIdentityMember) string {
	class := -1
	key := ""
	if member.target >= 0 {
		class = s.classes[member.target]
		key = s.classKeys[class]
	}
	return strconv.Quote(member.prefix) + ":" + strconv.Quote(key) +
		":" + strconv.Itoa(class) + ":" + strconv.Quote(member.suffix)
}

func typeObjectIdentity(object *types.TypeName) string {
	if object == nil {
		return ""
	}
	owner := ""
	if object.Pkg() != nil {
		owner = object.Pkg().Path()
	}
	return owner + ":" + object.Name()
}

func typeKind(t types.Type) string {
	switch t.(type) {
	case *types.Alias:
		return "alias"
	case *types.Array:
		return "array"
	case *types.Basic:
		return "basic"
	case *types.Chan:
		return "channel"
	case *types.Interface:
		return "interface"
	case *types.Map:
		return "map"
	case *types.Named:
		return "named"
	case *types.Pointer:
		return "pointer"
	case *types.Signature:
		return "signature"
	case *types.Slice:
		return "slice"
	case *types.Struct:
		return "struct"
	case *types.Tuple:
		return "tuple"
	case *types.TypeParam:
		return "typeParameter"
	case *types.Union:
		return "union"
	default:
		return fmt.Sprintf("%T", t)
	}
}

func typeDetails(t types.Type) (pkg, name string, alias, named bool, args []types.Type, underlying string) {
	switch value := t.(type) {
	case *types.Alias:
		alias = true
		name = value.Obj().Name()
		if value.Obj().Pkg() != nil {
			pkg = value.Obj().Pkg().Path()
		}
		if list := value.TypeArgs(); list != nil {
			for i := 0; i < list.Len(); i++ {
				args = append(args, list.At(i))
			}
		}
		underlying = canonicalType(value.Underlying())
	case *types.Named:
		named = true
		name = value.Obj().Name()
		if value.Obj().Pkg() != nil {
			pkg = value.Obj().Pkg().Path()
		}
		if list := value.TypeArgs(); list != nil {
			for i := 0; i < list.Len(); i++ {
				args = append(args, list.At(i))
			}
		}
		underlying = canonicalType(value.Underlying())
	default:
		underlying = canonicalType(t.Underlying())
	}
	return
}

func objectKind(object types.Object) string {
	switch object.(type) {
	case *types.Builtin:
		return "builtin"
	case *types.Const:
		return "constant"
	case *types.Func:
		return "function"
	case *types.Label:
		return "label"
	case *types.Nil:
		return "nil"
	case *types.PkgName:
		return "package"
	case *types.TypeName:
		return "type"
	case *types.Var:
		return "variable"
	default:
		return fmt.Sprintf("%T", object)
	}
}

func objectCanonical(pkgID string, object types.Object, declaration string) string {
	if object == nil {
		return ""
	}
	owner := ""
	if object.Pkg() != nil {
		owner = object.Pkg().Path()
	}
	if declaration == "" {
		declaration = owner + "\x00" + object.Name() + "\x00" + canonicalTypeIdentity(object.Type())
		if function, ok := object.(*types.Func); ok {
			if signature, ok := function.Type().(*types.Signature); ok && signature.Recv() != nil {
				declaration += "\x00receiver=" + canonicalTypeIdentity(signature.Recv().Type())
			}
		}
	}
	return pkgID + "\x00" + objectKind(object) + "\x00" + declaration
}

func selectionKind(kind types.SelectionKind) string {
	switch kind {
	case types.FieldVal:
		return "field"
	case types.MethodVal:
		return "method-value"
	case types.MethodExpr:
		return "method-expression"
	default:
		return fmt.Sprintf("selection-%d", kind)
	}
}

func selectionObjectIdentity(selection *types.Selection) string {
	index := make([]string, len(selection.Index()))
	for i, value := range selection.Index() {
		index[i] = strconv.Itoa(value)
	}
	return "selection\x00" + canonicalTypeIdentity(selection.Recv()) + "\x00" + strings.Join(index, ".")
}

func methodSetObjects(t types.Type) []types.Object {
	set := types.NewMethodSet(t)
	result := make([]types.Object, 0, set.Len())
	for i := 0; i < set.Len(); i++ {
		result = append(result, set.At(i).Obj())
	}
	sort.Slice(result, func(i, j int) bool {
		left := result[i].Name() + "\x00" + canonicalType(result[i].Type())
		right := result[j].Name() + "\x00" + canonicalType(result[j].Type())
		return left < right
	})
	return result
}

func constantCategory(t types.Type) string {
	basic, ok := t.Underlying().(*types.Basic)
	if !ok {
		return "unknown"
	}
	switch {
	case basic.Info()&types.IsBoolean != 0:
		return "boolean"
	case basic.Info()&types.IsInteger != 0:
		return "integer"
	case basic.Info()&types.IsFloat != 0:
		return "rational"
	case basic.Info()&types.IsComplex != 0:
		return "complex"
	case basic.Info()&types.IsString != 0:
		return "string"
	default:
		return strings.ToLower(basic.Name())
	}
}

func isUntyped(t types.Type) bool {
	basic, ok := t.(*types.Basic)
	return ok && basic.Info()&types.IsUntyped != 0
}
