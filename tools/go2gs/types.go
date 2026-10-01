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
	display := canonicalType(t)
	if t == nil {
		return display
	}
	seen := map[types.Type]bool{}
	declarations := map[string]bool{}
	var walk func(types.Type)
	walk = func(current types.Type) {
		if current == nil || seen[current] {
			return
		}
		seen[current] = true
		switch value := current.(type) {
		case *types.TypeParam:
			declarations["typeparam:"+identify(value.Obj())] = true
			walk(value.Constraint())
		case *types.Named:
			declarations["named:"+identify(value.Obj())] = true
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i))
				}
			}
			walk(value.Underlying())
		case *types.Alias:
			declarations["alias:"+identify(value.Obj())] = true
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i))
				}
			}
			walk(value.Underlying())
		case *types.Array:
			walk(value.Elem())
		case *types.Slice:
			walk(value.Elem())
		case *types.Pointer:
			walk(value.Elem())
		case *types.Map:
			walk(value.Key())
			walk(value.Elem())
		case *types.Chan:
			walk(value.Elem())
		case *types.Struct:
			for i := 0; i < value.NumFields(); i++ {
				walk(value.Field(i).Type())
			}
		case *types.Tuple:
			for i := 0; i < value.Len(); i++ {
				walk(value.At(i).Type())
			}
		case *types.Signature:
			if value.Recv() != nil {
				walk(value.Recv().Type())
			}
			if parameters := value.TypeParams(); parameters != nil {
				for i := 0; i < parameters.Len(); i++ {
					walk(parameters.At(i))
				}
			}
			walk(value.Params())
			walk(value.Results())
		case *types.Interface:
			value.Complete()
			for i := 0; i < value.NumMethods(); i++ {
				walk(value.Method(i).Type())
			}
			for i := 0; i < value.NumEmbeddeds(); i++ {
				walk(value.EmbeddedType(i))
			}
		case *types.Union:
			for i := 0; i < value.Len(); i++ {
				walk(value.Term(i).Type())
			}
		}
	}
	walk(t)
	structuralOwners := structuralTypeOwners(t)
	if len(declarations) == 0 {
		if len(structuralOwners) == 0 {
			return display
		}
		return display + "\x00structuralOwners=" + strings.Join(structuralOwners, ",")
	}
	keys := make([]string, 0, len(declarations))
	for declaration := range declarations {
		keys = append(keys, declaration)
	}
	sort.Strings(keys)
	result := display + "\x00declarations=" + strings.Join(keys, ",")
	if len(structuralOwners) != 0 {
		result += "\x00structuralOwners=" + strings.Join(structuralOwners, ",")
	}
	return result
}

func structuralTypeOwners(t types.Type) []string {
	var result []string
	active := map[types.Type]bool{}
	var walk func(types.Type, string)
	walk = func(current types.Type, position string) {
		if current == nil || active[current] {
			return
		}
		active[current] = true
		defer delete(active, current)
		switch value := current.(type) {
		case *types.Named:
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i), position+".argument["+strconv.Itoa(i)+"]")
				}
			}
		case *types.Alias:
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i), position+".argument["+strconv.Itoa(i)+"]")
				}
			}
		case *types.Array:
			walk(value.Elem(), position+".element")
		case *types.Slice:
			walk(value.Elem(), position+".element")
		case *types.Pointer:
			walk(value.Elem(), position+".element")
		case *types.Map:
			walk(value.Key(), position+".key")
			walk(value.Elem(), position+".element")
		case *types.Chan:
			walk(value.Elem(), position+".element")
		case *types.Struct:
			for i := 0; i < value.NumFields(); i++ {
				field := value.Field(i)
				fieldPosition := position + ".field[" + strconv.Itoa(i) + "]"
				if !field.Exported() && field.Pkg() != nil {
					result = append(result, fieldPosition+"="+strconv.Quote(field.Pkg().Path()))
				}
				walk(field.Type(), fieldPosition+".type")
			}
		case *types.Tuple:
			for i := 0; i < value.Len(); i++ {
				walk(value.At(i).Type(), position+".tuple["+strconv.Itoa(i)+"]")
			}
		case *types.Signature:
			if value.Recv() != nil {
				walk(value.Recv().Type(), position+".receiver")
			}
			if parameters := value.RecvTypeParams(); parameters != nil {
				for i := 0; i < parameters.Len(); i++ {
					walk(parameters.At(i), position+".receiverTypeParameter["+strconv.Itoa(i)+"]")
				}
			}
			if parameters := value.TypeParams(); parameters != nil {
				for i := 0; i < parameters.Len(); i++ {
					walk(parameters.At(i), position+".typeParameter["+strconv.Itoa(i)+"]")
				}
			}
			walk(value.Params(), position+".parameters")
			walk(value.Results(), position+".results")
		case *types.TypeParam:
			walk(value.Constraint(), position+".constraint")
		case *types.Interface:
			value.Complete()
			for i := 0; i < value.NumMethods(); i++ {
				method := value.Method(i)
				methodPosition := position + ".method[" + strconv.Itoa(i) + "]"
				if !method.Exported() && method.Pkg() != nil {
					result = append(result, methodPosition+"="+strconv.Quote(method.Pkg().Path()))
				}
				walk(method.Type(), methodPosition+".type")
			}
			for i := 0; i < value.NumEmbeddeds(); i++ {
				walk(value.EmbeddedType(i), position+".embedded["+strconv.Itoa(i)+"]")
			}
		case *types.Union:
			for i := 0; i < value.Len(); i++ {
				walk(value.Term(i).Type(), position+".term["+strconv.Itoa(i)+"]")
			}
		}
	}
	walk(t, "root")
	return result
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
