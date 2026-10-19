package fixture

import (
	"embed"
	"fmt"
)

const (
	HugeInteger  = 1234567890123456789012345678901234567890
	ExactThird   = 1.0 / 3.0
	ExactComplex = HugeInteger + ExactThird*1i
	IotaZero     = iota
	IotaOne
	MixedIota, MixedZero = iota, 0
)

type Box[T comparable] struct {
	Value T `json:"value"`
}

type Triple [3]int

type Inner struct {
	Number int
}

type Outer struct {
	Inner
}

func Identity[T comparable](value T) T {
	return value
}

func (outer *Outer) Add(value int) int {
	return outer.Number + value
}

//go:embed assets/*
var regularAssets embed.FS

//go:embed all:assets/*
var allAssets embed.FS

//go:embed assets/sub
var directoryAssets embed.FS

//go:generate echo never-executed

var InterfaceValue any = (*Inner)(nil)
var ContextualInt int64 = 7
var Convert = int64(4)
var NestedConvert = int64(int32(5))
var PackageCall = fmt.Sprint(8)
var MethodExpressionCall = (*Outer).Add(&Outer{}, 9)
var MethodValueCall = (&Outer{}).Add(10)
var ByteString = string([]byte{0xff, 0})
var MapValue = map[string]int{"answer": 42}
var ArrayValue Triple

func Prerequisites(ch chan int) {
	defer recover()
	if false {
		go func() { ch <- 1 }()
		<-ch
		close(ch)
		panic(ByteString)
	}
}

//line logical/generated.go:200
func Use() int {
	outer := Outer{Inner: Inner{Number: 2}}
	return int(int64(Identity(outer.Add(3))))
}
