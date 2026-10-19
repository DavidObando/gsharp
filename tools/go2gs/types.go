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
	serializer := typeIdentitySerializer{
		identify:  identify,
		active:    map[types.Type]int{},
		completed: map[typeIdentityKey]int{},
	}
	root := serializer.reference(t, nil)
	var result strings.Builder
	result.WriteString("root=")
	result.WriteString(root)
	for id, definition := range serializer.nodes {
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

type typeIdentityBinderScope struct {
	parent   *typeIdentityBinderScope
	bindings map[*types.TypeParam]string
}

func (s *typeIdentityBinderScope) lookup(parameter *types.TypeParam) (string, bool) {
	for current := s; current != nil; current = current.parent {
		if binding, ok := current.bindings[parameter]; ok {
			return binding, true
		}
	}
	return "", false
}

type typeIdentitySerializer struct {
	identify  func(*types.TypeName) string
	active    map[types.Type]int
	completed map[typeIdentityKey]int
	nodes     []string
}

func (s *typeIdentitySerializer) reference(t types.Type, scope *typeIdentityBinderScope) string {
	if t == nil {
		return "nil"
	}
	if parameter, ok := t.(*types.TypeParam); ok {
		if binding, bound := scope.lookup(parameter); bound {
			return binding
		}
	}
	if id, ok := s.active[t]; ok {
		return typeIdentityNodeReference(id)
	}
	key := typeIdentityKey{t: t, scope: scope}
	if id, ok := s.completed[key]; ok {
		return typeIdentityNodeReference(id)
	}
	id := len(s.nodes)
	s.nodes = append(s.nodes, "")
	s.active[t] = id
	s.nodes[id] = s.definition(id, t, scope)
	delete(s.active, t)
	s.completed[key] = id
	return typeIdentityNodeReference(id)
}

func typeIdentityNodeReference(id int) string {
	return "@" + strconv.Itoa(id)
}

func (s *typeIdentitySerializer) definition(id int, t types.Type, scope *typeIdentityBinderScope) string {
	switch value := t.(type) {
	case *types.Alias:
		return "alias(declaration=" + strconv.Quote(s.identify(value.Obj())) +
			",arguments=" + s.typeList(value.TypeArgs(), scope) +
			",underlying=" + s.reference(value.Underlying(), scope) + ")"
	case *types.Array:
		return "array(length=" + strconv.FormatInt(value.Len(), 10) +
			",element=" + s.reference(value.Elem(), scope) + ")"
	case *types.Basic:
		return "basic(" + strconv.Quote(canonicalType(value)) + ")"
	case *types.Chan:
		return "channel(direction=" + strconv.Itoa(int(value.Dir())) +
			",element=" + s.reference(value.Elem(), scope) + ")"
	case *types.Interface:
		value.Complete()
		var methods []string
		for i := 0; i < value.NumMethods(); i++ {
			method := value.Method(i)
			owner := ""
			if !method.Exported() && method.Pkg() != nil {
				owner = method.Pkg().Path()
			}
			methods = append(methods, "method(name="+strconv.Quote(method.Name())+
				",owner="+strconv.Quote(owner)+",type="+s.reference(method.Type(), scope)+")")
		}
		var embedded []string
		for i := 0; i < value.NumEmbeddeds(); i++ {
			embedded = append(embedded, s.reference(value.EmbeddedType(i), scope))
		}
		return "interface(methods=[" + strings.Join(methods, ",") +
			"],embedded=[" + strings.Join(embedded, ",") + "])"
	case *types.Map:
		return "map(key=" + s.reference(value.Key(), scope) +
			",element=" + s.reference(value.Elem(), scope) + ")"
	case *types.Named:
		return "named(declaration=" + strconv.Quote(s.identify(value.Obj())) +
			",arguments=" + s.typeList(value.TypeArgs(), scope) +
			",underlying=" + s.reference(value.Underlying(), scope) + ")"
	case *types.Pointer:
		return "pointer(element=" + s.reference(value.Elem(), scope) + ")"
	case *types.Signature:
		signatureScope := s.signatureScope(id, value, scope)
		receiver := "nil"
		if value.Recv() != nil {
			receiver = s.reference(value.Recv().Type(), signatureScope)
		}
		return "signature(receiver=" + receiver +
			",receiverTypeParameters=" + s.typeParameterConstraints(value.RecvTypeParams(), signatureScope) +
			",typeParameters=" + s.typeParameterConstraints(value.TypeParams(), signatureScope) +
			",parameters=" + s.reference(value.Params(), signatureScope) +
			",results=" + s.reference(value.Results(), signatureScope) +
			",variadic=" + strconv.FormatBool(value.Variadic()) + ")"
	case *types.Slice:
		return "slice(element=" + s.reference(value.Elem(), scope) + ")"
	case *types.Struct:
		var fields []string
		for i := 0; i < value.NumFields(); i++ {
			field := value.Field(i)
			owner := ""
			if !field.Exported() && field.Pkg() != nil {
				owner = field.Pkg().Path()
			}
			fields = append(fields, "field(name="+strconv.Quote(field.Name())+
				",owner="+strconv.Quote(owner)+
				",embedded="+strconv.FormatBool(field.Embedded())+
				",tag="+strconv.Quote(value.Tag(i))+
				",type="+s.reference(field.Type(), scope)+")")
		}
		return "struct(fields=[" + strings.Join(fields, ",") + "])"
	case *types.Tuple:
		var elements []string
		for i := 0; i < value.Len(); i++ {
			elements = append(elements, s.reference(value.At(i).Type(), scope))
		}
		return "tuple(elements=[" + strings.Join(elements, ",") + "])"
	case *types.TypeParam:
		return "freeTypeParameter(declaration=" + strconv.Quote(s.identify(value.Obj())) +
			",constraint=" + s.reference(value.Constraint(), scope) + ")"
	case *types.Union:
		var terms []string
		for i := 0; i < value.Len(); i++ {
			term := value.Term(i)
			terms = append(terms, "term(tilde="+strconv.FormatBool(term.Tilde())+
				",type="+s.reference(term.Type(), scope)+")")
		}
		return "union(terms=[" + strings.Join(terms, ",") + "])"
	default:
		return "unknown(display=" + strconv.Quote(canonicalType(t)) + ")"
	}
}

func (s *typeIdentitySerializer) signatureScope(
	id int,
	signature *types.Signature,
	parent *typeIdentityBinderScope,
) *typeIdentityBinderScope {
	scope := &typeIdentityBinderScope{parent: parent, bindings: map[*types.TypeParam]string{}}
	if parameters := signature.RecvTypeParams(); parameters != nil {
		for i := 0; i < parameters.Len(); i++ {
			scope.bindings[parameters.At(i)] = "$" + strconv.Itoa(id) + ".receiver[" + strconv.Itoa(i) + "]"
		}
	}
	if parameters := signature.TypeParams(); parameters != nil {
		for i := 0; i < parameters.Len(); i++ {
			scope.bindings[parameters.At(i)] = "$" + strconv.Itoa(id) + ".type[" + strconv.Itoa(i) + "]"
		}
	}
	return scope
}

func (s *typeIdentitySerializer) typeList(
	types *types.TypeList,
	scope *typeIdentityBinderScope,
) string {
	if types == nil {
		return "[]"
	}
	values := make([]string, types.Len())
	for i := 0; i < types.Len(); i++ {
		values[i] = s.reference(types.At(i), scope)
	}
	return "[" + strings.Join(values, ",") + "]"
}

func (s *typeIdentitySerializer) typeParameterConstraints(
	parameters *types.TypeParamList,
	scope *typeIdentityBinderScope,
) string {
	if parameters == nil {
		return "[]"
	}
	values := make([]string, parameters.Len())
	for i := 0; i < parameters.Len(); i++ {
		values[i] = s.reference(parameters.At(i).Constraint(), scope)
	}
	return "[" + strings.Join(values, ",") + "]"
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
