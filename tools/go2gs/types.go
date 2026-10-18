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
	display := canonicalTypeIdentityText(t)
	if t == nil {
		return display
	}
	active := map[types.Type]string{}
	var declarations []string
	var walk func(types.Type, string)
	walk = func(current types.Type, position string) {
		if current == nil {
			return
		}
		if ancestor, ok := active[current]; ok {
			declarations = append(declarations, position+"=cycle:"+ancestor)
			return
		}
		active[current] = position
		defer delete(active, current)
		switch value := current.(type) {
		case *types.TypeParam:
			declarations = append(declarations, position+"=typeparam:"+strconv.Quote(identify(value.Obj())))
			walk(value.Constraint(), position+".constraint")
		case *types.Named:
			declarations = append(declarations, position+"=named:"+strconv.Quote(identify(value.Obj())))
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i), position+".argument["+strconv.Itoa(i)+"]")
				}
			}
			walk(value.Underlying(), position+".underlying")
		case *types.Alias:
			declarations = append(declarations, position+"=alias:"+strconv.Quote(identify(value.Obj())))
			if arguments := value.TypeArgs(); arguments != nil {
				for i := 0; i < arguments.Len(); i++ {
					walk(arguments.At(i), position+".argument["+strconv.Itoa(i)+"]")
				}
			}
			walk(value.Underlying(), position+".underlying")
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
				walk(value.Field(i).Type(), position+".field["+strconv.Itoa(i)+"].type")
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
		case *types.Interface:
			value.Complete()
			for i := 0; i < value.NumMethods(); i++ {
				walk(value.Method(i).Type(), position+".method["+strconv.Itoa(i)+"].type")
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
	structuralOwners := structuralTypeOwners(t)
	if len(declarations) == 0 {
		if len(structuralOwners) == 0 {
			return display
		}
		return display + "\x00structuralOwners=" + strings.Join(structuralOwners, ",")
	}
	result := display + "\x00declarations=" + strings.Join(declarations, ",")
	if len(structuralOwners) != 0 {
		result += "\x00structuralOwners=" + strings.Join(structuralOwners, ",")
	}
	return result
}

func canonicalTypeIdentityText(t types.Type) string {
	var result strings.Builder
	writeCanonicalTypeIdentity(&result, t)
	return result.String()
}

func writeCanonicalTypeIdentity(result *strings.Builder, t types.Type) {
	switch value := t.(type) {
	case nil:
	case *types.Alias:
		writeTypeName(result, value.Obj())
		writeTypeArguments(result, value.TypeArgs())
	case *types.Array:
		result.WriteByte('[')
		result.WriteString(strconv.FormatInt(value.Len(), 10))
		result.WriteByte(']')
		writeCanonicalTypeIdentity(result, value.Elem())
	case *types.Basic:
		result.WriteString(canonicalType(value))
	case *types.Chan:
		switch value.Dir() {
		case types.SendOnly:
			result.WriteString("chan<- ")
		case types.RecvOnly:
			result.WriteString("<-chan ")
		default:
			result.WriteString("chan ")
		}
		writeCanonicalTypeIdentity(result, value.Elem())
	case *types.Interface:
		value.Complete()
		result.WriteString("interface{")
		separator := ""
		for i := 0; i < value.NumMethods(); i++ {
			result.WriteString(separator)
			result.WriteString(value.Method(i).Name())
			writeCanonicalSignature(result, value.Method(i).Type().(*types.Signature), false)
			separator = "; "
		}
		for i := 0; i < value.NumEmbeddeds(); i++ {
			result.WriteString(separator)
			writeCanonicalTypeIdentity(result, value.EmbeddedType(i))
			separator = "; "
		}
		result.WriteByte('}')
	case *types.Map:
		result.WriteString("map[")
		writeCanonicalTypeIdentity(result, value.Key())
		result.WriteByte(']')
		writeCanonicalTypeIdentity(result, value.Elem())
	case *types.Named:
		writeTypeName(result, value.Obj())
		writeTypeArguments(result, value.TypeArgs())
	case *types.Pointer:
		result.WriteByte('*')
		writeCanonicalTypeIdentity(result, value.Elem())
	case *types.Signature:
		writeCanonicalSignature(result, value, true)
	case *types.Slice:
		result.WriteString("[]")
		writeCanonicalTypeIdentity(result, value.Elem())
	case *types.Struct:
		result.WriteString("struct{")
		for i := 0; i < value.NumFields(); i++ {
			if i != 0 {
				result.WriteString("; ")
			}
			field := value.Field(i)
			if !field.Embedded() {
				result.WriteString(field.Name())
				result.WriteByte(' ')
			}
			writeCanonicalTypeIdentity(result, field.Type())
			if tag := value.Tag(i); tag != "" {
				result.WriteByte(' ')
				result.WriteString(strconv.Quote(tag))
			}
		}
		result.WriteByte('}')
	case *types.Tuple:
		writeCanonicalTuple(result, value, false)
	case *types.TypeParam:
		result.WriteString(value.Obj().Name())
	case *types.Union:
		for i := 0; i < value.Len(); i++ {
			if i != 0 {
				result.WriteString(" | ")
			}
			term := value.Term(i)
			if term.Tilde() {
				result.WriteByte('~')
			}
			writeCanonicalTypeIdentity(result, term.Type())
		}
	default:
		result.WriteString(canonicalType(t))
	}
}

func writeCanonicalSignature(result *strings.Builder, signature *types.Signature, keyword bool) {
	if keyword {
		result.WriteString("func")
	}
	if parameters := signature.TypeParams(); parameters != nil && parameters.Len() != 0 {
		result.WriteByte('[')
		for i := 0; i < parameters.Len(); i++ {
			if i != 0 {
				result.WriteString(", ")
			}
			parameter := parameters.At(i)
			result.WriteString(parameter.Obj().Name())
			result.WriteByte(' ')
			writeCanonicalTypeIdentity(result, parameter.Constraint())
		}
		result.WriteByte(']')
	}
	writeCanonicalTuple(result, signature.Params(), signature.Variadic())
	results := signature.Results()
	if results == nil || results.Len() == 0 {
		return
	}
	result.WriteByte(' ')
	if results.Len() == 1 {
		writeCanonicalTypeIdentity(result, results.At(0).Type())
		return
	}
	writeCanonicalTuple(result, results, false)
}

func writeCanonicalTuple(result *strings.Builder, tuple *types.Tuple, variadic bool) {
	result.WriteByte('(')
	if tuple != nil {
		for i := 0; i < tuple.Len(); i++ {
			if i != 0 {
				result.WriteString(", ")
			}
			t := tuple.At(i).Type()
			if variadic && i == tuple.Len()-1 {
				if slice, ok := t.(*types.Slice); ok {
					result.WriteString("...")
					t = slice.Elem()
				}
			}
			writeCanonicalTypeIdentity(result, t)
		}
	}
	result.WriteByte(')')
}

func writeTypeName(result *strings.Builder, object *types.TypeName) {
	if object.Pkg() != nil {
		result.WriteString(object.Pkg().Path())
		result.WriteByte('.')
	}
	result.WriteString(object.Name())
}

func writeTypeArguments(result *strings.Builder, arguments *types.TypeList) {
	if arguments == nil || arguments.Len() == 0 {
		return
	}
	result.WriteByte('[')
	for i := 0; i < arguments.Len(); i++ {
		if i != 0 {
			result.WriteString(", ")
		}
		writeCanonicalTypeIdentity(result, arguments.At(i))
	}
	result.WriteByte(']')
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
