package fixture

import _ "embed"

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

//go:generate echo never-executed

//line logical/generated.go:200
func Use() int {
	outer := Outer{Inner: Inner{Number: 2}}
	return int(int64(Identity(outer.Add(3))))
}
