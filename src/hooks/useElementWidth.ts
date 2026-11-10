import { useEffect, useRef, useState } from 'react'

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0].contentRect.width))
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}
