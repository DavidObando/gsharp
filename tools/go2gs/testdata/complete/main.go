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

//go:embed asset.bin
var asset string

//go:embed assets/a.txt
var assetA string

//go:embed assets/*.txt
var assets embed.FS

//go:generate echo never-executed

var InterfaceValue any = (*Inner)(nil)
var ContextualInt int64 = 7
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
